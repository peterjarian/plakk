import { open, stat } from "node:fs/promises";
import type { PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

type PreparedUploadBase = {
  readonly id: string;
  readonly prepared: PreparedStorageUpload;
  readonly byteSize: number;
};

export type PreparedFileUploadPayload = PreparedUploadBase &
  (
    | { readonly filePath: string; readonly bytes?: never }
    | { readonly bytes: Uint8Array; readonly filePath?: never }
  );

export type RendererPreparedFileUploadPayload = PreparedUploadBase &
  (
    | { readonly file: File; readonly filePath?: never; readonly bytes?: never }
    | { readonly filePath: string; readonly file?: never; readonly bytes?: never }
    | { readonly bytes: Uint8Array; readonly file?: never; readonly filePath?: never }
  );

export type StorageUploadResult = { readonly storageObjectId: string };

type UploadFetch = (input: string, init?: RequestInit) => Promise<Response>;

const uploadFailureDetail = (cause: unknown) => {
  const details: Array<string> = [];
  let current = cause;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth += 1) {
    const name = "name" in current && typeof current.name === "string" ? current.name : null;
    const code =
      "code" in current && (typeof current.code === "string" || typeof current.code === "number")
        ? current.code
        : null;
    const message =
      "message" in current &&
      typeof current.message === "string" &&
      /^net::ERR_[A-Z_]+$/.test(current.message)
        ? current.message
        : null;
    const detail = [name, code === null ? null : `code ${code}`, message].filter(Boolean).join(" ");
    if (detail !== "") details.push(detail);
    current = "cause" in current ? current.cause : null;
  }
  return details.join("; ");
};

export class StorageUploadError extends Schema.TaggedErrorClass<StorageUploadError>()(
  "StorageUploadError",
  {
    actionable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
    stalePreparation: Schema.Boolean,
  },
) {}

export class StorageUpload extends Context.Service<
  StorageUpload,
  {
    readonly upload: (
      payload: PreparedFileUploadPayload,
      onProgress: (progress: number) => void,
    ) => Effect.Effect<StorageUploadResult, StorageUploadError>;
  }
>()("@plakk/desktop/storageUpload/StorageUpload") {
  static layer(uploadFetch: UploadFetch = fetch) {
    return Layer.succeed(
      StorageUpload,
      StorageUpload.of({
        upload: Effect.fn("StorageUpload.upload")(function* (payload, onProgress) {
          return yield* Effect.tryPromise({
            try: (signal) => uploadPreparedFile(payload, onProgress, signal, uploadFetch),
            catch: (cause) =>
              new StorageUploadError({
                actionable: cause instanceof ProviderUploadHttpError && cause.actionable,
                cause,
                message: cause instanceof Error ? cause.message : "Could not upload file.",
                stalePreparation:
                  cause instanceof ProviderUploadHttpError && cause.stalePreparation,
              }),
          });
        }),
      }),
    );
  }
}

type ByteRange = { readonly start: number; readonly end: number };

class ProviderUploadHttpError extends Error {
  readonly actionable: boolean;
  readonly stalePreparation: boolean;
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Upload failed: ${status}${body ? ` ${body}` : ""}`);
    this.status = status;
    const quotaFailure = status === 507 || (status === 403 && /quota|storage.+full/i.test(body));
    this.stalePreparation = [401, 404, 410].includes(status) || (status === 403 && !quotaFailure);
    this.actionable = quotaFailure;
  }
}

const uploadHeaders = (
  headers: PreparedStorageUpload["upload"]["headers"],
): Record<string, string> =>
  Object.fromEntries(headers.map((header) => [header.name, header.value]));

async function assertUploadSource(payload: PreparedFileUploadPayload) {
  if (payload.bytes !== undefined) {
    if (payload.bytes.byteLength !== payload.byteSize)
      throw new Error("Upload source size changed before upload.");
    return;
  }
  const details = await stat(payload.filePath);
  if (!details.isFile()) throw new Error("Upload source is not a file.");
  if (details.size !== payload.byteSize)
    throw new Error("Upload source size changed before upload.");
}

async function readUploadPart(input: {
  readonly source: PreparedFileUploadPayload;
  readonly start: number;
  readonly byteSize: number;
}) {
  if (input.source.bytes !== undefined) {
    return new Blob([
      input.source.bytes.slice(
        input.start,
        input.start + input.byteSize,
      ) as Uint8Array<ArrayBuffer>,
    ]);
  }
  const file = await open(input.source.filePath);
  const bytes = Buffer.allocUnsafe(input.byteSize);
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        input.start + offset,
      );
      if (bytesRead === 0) throw new Error("Upload source ended before the requested range.");
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
  return new Blob([bytes]);
}

const partByteSize = (
  strategy: Extract<PreparedStorageUpload["upload"]["strategy"], { type: "byte_range" }>,
) => {
  const size =
    Math.floor(strategy.maxPartByteSize / strategy.partByteMultiple) * strategy.partByteMultiple;
  if (size < 1) throw new Error("Upload part size is invalid.");
  return size;
};

async function uploadPart(input: {
  readonly upload: PreparedStorageUpload["upload"];
  readonly source: PreparedFileUploadPayload;
  readonly byteSize: number;
  readonly range: ByteRange | null;
  readonly signal: AbortSignal | undefined;
  readonly uploadFetch: UploadFetch;
}) {
  const { upload, source, byteSize, range, signal, uploadFetch } = input;
  const partSize = range === null ? byteSize : range.end - range.start + 1;
  const body = await readUploadPart({
    source,
    start: range?.start ?? 0,
    byteSize: partSize,
  });

  let response: Response;
  try {
    response = await uploadFetch(upload.url, {
      method: upload.method,
      headers: {
        ...uploadHeaders(upload.headers),
        ...(range === null
          ? {}
          : { "Content-Range": `bytes ${range.start}-${range.end}/${byteSize}` }),
      },
      body,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    if (signal?.aborted) throw new Error("Upload cancelled. Choose the file again to retry.");
    const detail = uploadFailureDetail(cause);
    throw new Error(
      `Could not reach the upload link${detail ? `: ${detail}` : ""}. Choose the file again to retry.`,
    );
  }

  if (!response.ok && response.status !== 308) {
    const body = await response.text().catch(() => "");
    throw new ProviderUploadHttpError(response.status, body);
  }
  return response;
}

const confirmedRangeEnd = (response: Response) => {
  const range = response.headers.get("range");
  const match = range === null ? null : /(?:bytes=|bytes )\d+-(\d+)/.exec(range);
  if (match?.[1] === undefined)
    throw new Error("Upload session did not confirm the uploaded range.");
  return Number(match[1]);
};

async function nextExpectedStart(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  const range =
    typeof body === "object" && body !== null && "nextExpectedRanges" in body
      ? body.nextExpectedRanges
      : null;
  if (!Array.isArray(range) || typeof range[0] !== "string") {
    throw new Error("Upload session did not return the next expected range.");
  }
  const start = /^\d+/.exec(range[0]);
  if (start?.[0] === undefined) throw new Error("Upload session returned an invalid next range.");
  return Number(start[0]);
}

async function storageObjectIdFrom(response: Response, prepared: PreparedStorageUpload) {
  if (prepared.storageObjectId !== null) return prepared.storageObjectId;

  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body === "object" &&
    body !== null &&
    "id" in body &&
    typeof body.id === "string" &&
    body.id !== ""
  ) {
    return body.id;
  }
  throw new Error("Upload completed but the storage provider did not return an item ID.");
}

async function resumeByteRangeUpload(
  payload: PreparedFileUploadPayload,
  signal: AbortSignal | undefined,
  uploadFetch: UploadFetch,
): Promise<{ readonly start: number; readonly completed: StorageUploadResult | null }> {
  const { prepared } = payload;
  let response: Response;
  try {
    response = await uploadFetch(
      prepared.upload.url,
      prepared.storageProvider === "GOOGLE_DRIVE"
        ? {
            method: "PUT",
            headers: {
              ...uploadHeaders(prepared.upload.headers),
              "Content-Range": `bytes */${payload.byteSize}`,
            },
            body: new Blob([]),
            ...(signal === undefined ? {} : { signal }),
          }
        : {
            method: "GET",
            ...(signal === undefined ? {} : { signal }),
          },
    );
  } catch (cause) {
    if (signal?.aborted) throw new Error("Upload cancelled. Choose the file again to retry.");
    const detail = uploadFailureDetail(cause);
    throw new Error(`Could not check upload progress${detail ? `: ${detail}` : ""}.`);
  }

  if (!response.ok && response.status !== 308) {
    const body = await response.text().catch(() => "");
    throw new ProviderUploadHttpError(response.status, body);
  }
  if (prepared.storageProvider === "GOOGLE_DRIVE") {
    if (response.status !== 308) {
      return {
        start: payload.byteSize,
        completed: { storageObjectId: await storageObjectIdFrom(response, prepared) },
      };
    }
    const range = response.headers.get("range");
    return {
      start: range === null ? 0 : confirmedRangeEnd(response) + 1,
      completed: null,
    };
  }

  const body: unknown = await response.json().catch(() => null);
  const nextRanges =
    typeof body === "object" && body !== null && "nextExpectedRanges" in body
      ? body.nextExpectedRanges
      : null;
  if (Array.isArray(nextRanges) && typeof nextRanges[0] === "string") {
    const start = /^\d+/.exec(nextRanges[0]);
    if (start?.[0] !== undefined) return { start: Number(start[0]), completed: null };
  }
  if (
    typeof body === "object" &&
    body !== null &&
    "id" in body &&
    typeof body.id === "string" &&
    body.id !== ""
  ) {
    return { start: payload.byteSize, completed: { storageObjectId: body.id } };
  }
  throw new Error("Upload session did not report resumable progress.");
}

export async function uploadPreparedFile(
  payload: PreparedFileUploadPayload,
  onProgress: (progress: number) => void = () => undefined,
  signal?: AbortSignal,
  uploadFetch: UploadFetch = fetch,
): Promise<StorageUploadResult> {
  await assertUploadSource(payload);
  onProgress(0);

  if (payload.prepared.upload.strategy.type === "single_request") {
    const response = await uploadPart({
      upload: payload.prepared.upload,
      source: payload,
      byteSize: payload.byteSize,
      range: null,
      signal,
      uploadFetch,
    });
    const storageObjectId = await storageObjectIdFrom(response, payload.prepared);
    onProgress(100);
    return { storageObjectId };
  }

  const size = partByteSize(payload.prepared.upload.strategy);
  const resumed =
    payload.prepared.resume === true
      ? await resumeByteRangeUpload(payload, signal, uploadFetch)
      : { start: 0, completed: null };
  if (resumed.completed !== null) {
    onProgress(100);
    return resumed.completed;
  }
  let { start } = resumed;
  if (start > 0) onProgress(Math.min(99, Math.floor((start / payload.byteSize) * 100)));
  while (start < payload.byteSize) {
    const range = { start, end: Math.min(start + size, payload.byteSize) - 1 };
    const response = await uploadPart({
      upload: payload.prepared.upload,
      source: payload,
      byteSize: payload.byteSize,
      range,
      signal,
      uploadFetch,
    });
    if (response.status === 308) {
      const nextStart = confirmedRangeEnd(response) + 1;
      if (nextStart <= start) throw new Error("Upload session stalled; no progress confirmed.");
      start = nextStart;
      onProgress(Math.min(99, Math.floor((start / payload.byteSize) * 100)));
      continue;
    }
    if (response.status === 202) {
      const nextStart = await nextExpectedStart(response);
      if (nextStart <= start) throw new Error("Upload session stalled; no progress confirmed.");
      start = nextStart;
      onProgress(Math.min(99, Math.floor((start / payload.byteSize) * 100)));
      continue;
    }
    if (range.end !== payload.byteSize - 1) {
      throw new Error("Upload session completed before the final range.");
    }
    const storageObjectId = await storageObjectIdFrom(response, payload.prepared);
    onProgress(100);
    return { storageObjectId };
  }
  throw new Error("Upload session ended before the provider confirmed completion.");
}
