import type { PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import { Effect, FileSystem, Layer, Option } from "effect";
import {
  type PreparedFileUploadPayload,
  StorageUpload,
  StorageUploadError,
  type UploadFetch,
} from "./StorageUpload.ts";

type ByteRange = { readonly start: number; readonly end: number };

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

const uploadError = (message: string, cause?: unknown, retryable = false) =>
  new StorageUploadError({ ...(cause === undefined ? {} : { cause }), message, retryable });

const uploadHeaders = (
  headers: PreparedStorageUpload["upload"]["headers"],
): Record<string, string> =>
  Object.fromEntries(headers.map((header) => [header.name, header.value]));

const partByteSize = (
  strategy: Extract<PreparedStorageUpload["upload"]["strategy"], { type: "byte_range" }>,
) => {
  const size =
    Math.floor(strategy.maxPartByteSize / strategy.partByteMultiple) * strategy.partByteMultiple;
  return size < 1
    ? Effect.fail(uploadError("The upload provider returned an invalid part size."))
    : Effect.succeed(size);
};

const confirmedRangeEnd = (response: Response) => {
  const range = response.headers.get("range");
  const match = range === null ? null : /(?:bytes=|bytes )\d+-(\d+)/.exec(range);
  return match?.[1] === undefined
    ? Effect.fail(uploadError("The upload provider did not confirm the uploaded range."))
    : Effect.succeed(Number(match[1]));
};

const responseJson = (response: Response) =>
  Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () => null,
  }).pipe(Effect.catch(() => Effect.succeed(null)));

const nextExpectedStart = Effect.fn("StorageUpload.nextExpectedStart")(function* (
  response: Response,
) {
  const body = yield* responseJson(response);
  const range =
    typeof body === "object" && body !== null && "nextExpectedRanges" in body
      ? body.nextExpectedRanges
      : null;
  if (!Array.isArray(range) || typeof range[0] !== "string") {
    return yield* uploadError("The upload provider did not return the next expected range.");
  }
  const start = /^\d+/.exec(range[0]);
  if (start?.[0] === undefined) {
    return yield* uploadError("The upload provider returned an invalid expected range.");
  }
  return Number(start[0]);
});

const storageObjectIdFrom = Effect.fn("StorageUpload.storageObjectId")(function* (
  response: Response,
  prepared: PreparedStorageUpload,
) {
  if (prepared.storageObjectId !== null) return prepared.storageObjectId;

  const body = yield* responseJson(response);
  if (
    typeof body === "object" &&
    body !== null &&
    "id" in body &&
    typeof body.id === "string" &&
    body.id !== ""
  ) {
    return body.id;
  }
  return yield* uploadError("The upload completed, but the provider did not return the file ID.");
});

const makeUploadPreparedFile = (fileSystem: FileSystem.FileSystem, uploadFetch: UploadFetch) => {
  const assertUploadSource = Effect.fn("StorageUpload.assertSource")(function* (
    payload: PreparedFileUploadPayload,
  ) {
    const details = yield* fileSystem
      .stat(payload.filePath)
      .pipe(
        Effect.mapError((cause) =>
          uploadError("The local copy of this snippet is unavailable.", cause),
        ),
      );
    if (details.type !== "File") {
      return yield* uploadError("The local copy of this snippet is not a file.");
    }
    if (Number(details.size) !== payload.byteSize) {
      return yield* uploadError("The local copy of this snippet is incomplete.");
    }
  });

  const readUploadPart = Effect.fn("StorageUpload.readPart")(function* (input: {
    readonly source: PreparedFileUploadPayload;
    readonly start: number;
    readonly byteSize: number;
  }) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem
          .open(input.source.filePath)
          .pipe(
            Effect.mapError((cause) =>
              uploadError("The local copy of this snippet could not be opened.", cause),
            ),
          );
        yield* file.seek(input.start, "start");
        const chunks: Array<Uint8Array<ArrayBuffer>> = [];
        let remaining = input.byteSize;
        while (remaining > 0) {
          const chunk = yield* file
            .readAlloc(remaining)
            .pipe(
              Effect.mapError((cause) =>
                uploadError("The local copy of this snippet could not be read.", cause),
              ),
            );
          if (Option.isNone(chunk)) {
            return yield* uploadError("The local copy ended before the requested upload range.");
          }
          const bytes = Uint8Array.from(chunk.value);
          chunks.push(bytes);
          remaining -= bytes.byteLength;
        }
        return new Blob(chunks);
      }),
    );
  });

  const uploadPart = Effect.fn("StorageUpload.uploadPart")(function* (input: {
    readonly upload: PreparedStorageUpload["upload"];
    readonly source: PreparedFileUploadPayload;
    readonly byteSize: number;
    readonly range: ByteRange | null;
  }) {
    const partSize =
      input.range === null ? input.byteSize : input.range.end - input.range.start + 1;
    const body = yield* readUploadPart({
      source: input.source,
      start: input.range?.start ?? 0,
      byteSize: partSize,
    });

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        uploadFetch(input.upload.url, {
          method: input.upload.method,
          headers: {
            ...uploadHeaders(input.upload.headers),
            ...(input.range === null
              ? {}
              : {
                  "Content-Range": `bytes ${input.range.start}-${input.range.end}/${input.byteSize}`,
                }),
          },
          body,
          signal,
        }),
      catch: (cause) => {
        const detail = uploadFailureDetail(cause);
        return uploadError(
          `Could not reach the upload provider${detail ? ` (${detail})` : ""}.`,
          cause,
          true,
        );
      },
    });

    if (!response.ok && response.status !== 308) {
      const retryable =
        response.status === 401 ||
        response.status === 404 ||
        response.status === 408 ||
        response.status === 410 ||
        response.status === 429 ||
        response.status >= 500;
      return yield* uploadError(
        `The upload provider rejected the file (${response.status}).`,
        undefined,
        retryable,
      );
    }
    return response;
  });

  return Effect.fn("StorageUpload.upload")(function* (
    payload: PreparedFileUploadPayload,
    onProgress: (progress: number) => void,
  ) {
    yield* assertUploadSource(payload);
    yield* Effect.sync(() => onProgress(0));

    if (payload.prepared.upload.strategy.type === "single_request") {
      const response = yield* uploadPart({
        upload: payload.prepared.upload,
        source: payload,
        byteSize: payload.byteSize,
        range: null,
      });
      const storageObjectId = yield* storageObjectIdFrom(response, payload.prepared);
      yield* Effect.sync(() => onProgress(100));
      return { storageObjectId };
    }

    const size = yield* partByteSize(payload.prepared.upload.strategy);
    let start = 0;
    while (start < payload.byteSize) {
      const range = { start, end: Math.min(start + size, payload.byteSize) - 1 };
      const response = yield* uploadPart({
        upload: payload.prepared.upload,
        source: payload,
        byteSize: payload.byteSize,
        range,
      });
      if (response.status === 308) {
        const nextStart = (yield* confirmedRangeEnd(response)) + 1;
        if (nextStart <= start) return yield* uploadError("The upload session stopped advancing.");
        start = nextStart;
        yield* Effect.sync(() =>
          onProgress(Math.min(99, Math.floor((start / payload.byteSize) * 100))),
        );
        continue;
      }
      if (response.status === 202) {
        const nextStart = yield* nextExpectedStart(response);
        if (nextStart <= start) return yield* uploadError("The upload session stopped advancing.");
        start = nextStart;
        yield* Effect.sync(() =>
          onProgress(Math.min(99, Math.floor((start / payload.byteSize) * 100))),
        );
        continue;
      }
      if (range.end !== payload.byteSize - 1) {
        return yield* uploadError("The upload provider completed before receiving the whole file.");
      }
      const storageObjectId = yield* storageObjectIdFrom(response, payload.prepared);
      yield* Effect.sync(() => onProgress(100));
      return { storageObjectId };
    }
    return yield* uploadError("The upload session ended before completion.");
  });
};

export const uploadPreparedFile = Effect.fn("StorageUpload.uploadPreparedFile")(function* (
  payload: PreparedFileUploadPayload,
  onProgress: (progress: number) => void = () => undefined,
  uploadFetch: UploadFetch = fetch,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* makeUploadPreparedFile(fileSystem, uploadFetch)(payload, onProgress);
});

export const makeStorageUploadLive = (uploadFetch: UploadFetch = fetch) =>
  Layer.effect(
    StorageUpload,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return StorageUpload.of({ upload: makeUploadPreparedFile(fileSystem, uploadFetch) });
    }),
  );
