import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export type PreparedFileUploadPayload = {
  readonly id: string;
  readonly prepared: PreparedStorageUpload;
  readonly filePath: string;
  readonly byteSize: number;
};

export type RendererPreparedFileUploadPayload = Omit<PreparedFileUploadPayload, "filePath"> & {
  readonly file: File;
};

export type StorageUploadResult = { readonly storageObjectId: string | null };

export class StorageUploadError extends Schema.TaggedErrorClass<StorageUploadError>()(
  "StorageUploadError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
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
  static readonly layer = Layer.succeed(
    StorageUpload,
    StorageUpload.of({
      upload: Effect.fn("StorageUpload.upload")(function* (payload, onProgress) {
        return yield* Effect.tryPromise({
          try: (signal) => uploadPreparedFile(payload, onProgress, signal),
          catch: (cause) =>
            new StorageUploadError({
              cause,
              message: cause instanceof Error ? cause.message : "Could not upload file.",
            }),
        });
      }),
    }),
  );
}

type ByteRange = { readonly start: number; readonly end: number };

const uploadHeaders = (
  headers: PreparedStorageUpload["upload"]["headers"],
): Record<string, string> =>
  Object.fromEntries(headers.map((header) => [header.name, header.value]));

async function assertUploadFile(filePath: string, byteSize: number) {
  const details = await stat(filePath);
  if (!details.isFile()) throw new Error("Upload source is not a file.");
  if (details.size !== byteSize) throw new Error("Upload source size changed before upload.");
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
  readonly filePath: string;
  readonly byteSize: number;
  readonly range: ByteRange | null;
  readonly signal: AbortSignal | undefined;
  readonly onProgress: (progress: number) => void;
}) {
  const { upload, filePath, byteSize, range, signal, onProgress } = input;
  const source = createReadStream(filePath, range ?? undefined);
  let uploadedBytes = range?.start ?? 0;
  source.on("data", (chunk: string | Buffer) => {
    uploadedBytes += Buffer.byteLength(chunk);
    onProgress(Math.min(99, Math.floor((uploadedBytes / byteSize) * 100)));
  });
  const partSize = range === null ? byteSize : range.end - range.start + 1;

  let response: Response;
  try {
    response = await fetch(upload.url, {
      method: upload.method,
      headers: {
        ...uploadHeaders(upload.headers),
        "Content-Length": String(partSize),
        ...(range === null
          ? {}
          : { "Content-Range": `bytes ${range.start}-${range.end}/${byteSize}` }),
      },
      body: source as unknown as BodyInit,
      duplex: "half",
      signal,
    } as RequestInit & { duplex: "half" });
  } catch {
    if (signal?.aborted) throw new Error("Upload cancelled. Choose the file again to retry.");
    throw new Error(
      "Could not reach the upload link. It may have expired; choose the file again to retry.",
    );
  }

  if (!response.ok && response.status !== 308) {
    const body = await response.text().catch(() => "");
    throw new Error(`Upload failed: ${response.status}${body ? ` ${body}` : ""}`);
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

export async function uploadPreparedFile(
  payload: PreparedFileUploadPayload,
  onProgress: (progress: number) => void = () => undefined,
  signal?: AbortSignal,
): Promise<StorageUploadResult> {
  await assertUploadFile(payload.filePath, payload.byteSize);
  onProgress(0);

  if (payload.prepared.upload.strategy.type === "single_request") {
    const response = await uploadPart({
      upload: payload.prepared.upload,
      filePath: payload.filePath,
      byteSize: payload.byteSize,
      range: null,
      signal,
      onProgress,
    });
    const storageObjectId = await storageObjectIdFrom(response, payload.prepared);
    onProgress(100);
    return { storageObjectId };
  }

  const size = partByteSize(payload.prepared.upload.strategy);
  let start = 0;
  while (start < payload.byteSize) {
    const range = { start, end: Math.min(start + size, payload.byteSize) - 1 };
    const response = await uploadPart({
      upload: payload.prepared.upload,
      filePath: payload.filePath,
      byteSize: payload.byteSize,
      range,
      signal,
      onProgress,
    });
    if (response.status === 308) {
      start = confirmedRangeEnd(response) + 1;
      continue;
    }
    if (response.status === 202) {
      start = await nextExpectedStart(response);
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
