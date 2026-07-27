import { isSupportedProviderUploadTarget } from "@plakk/shared";
import type { PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type BrowserUploadFetch = (input: string, init?: RequestInit) => Promise<Response>;

export const browserUploadFetch: BrowserUploadFetch = (input, init) =>
  globalThis.fetch(input, init);

export class WebProviderTransferError extends Schema.TaggedErrorClass<WebProviderTransferError>()(
  "WebProviderTransferError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

const transferError = (message: string, cause?: unknown) =>
  new WebProviderTransferError({
    ...(cause === undefined ? {} : { cause }),
    message,
  });

const responseJson = (response: Response) =>
  Effect.tryPromise(() => response.json() as Promise<unknown>).pipe(
    Effect.orElseSucceed(() => null),
  );

const responseObjectId = Effect.fn("WebProviderTransfer.responseObjectId")(function* (
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
  return yield* transferError("The upload completed, but the provider returned no file identity.");
});

const nextExpectedStart = Effect.fn("WebProviderTransfer.nextExpectedStart")(function* (
  response: Response,
) {
  if (response.status === 308) {
    const range = response.headers.get("range");
    const match = range === null ? null : /(?:bytes=|bytes )\d+-(\d+)/.exec(range);
    if (match?.[1] !== undefined) return Number(match[1]) + 1;
  }
  const body = yield* responseJson(response);
  const ranges =
    typeof body === "object" && body !== null && "nextExpectedRanges" in body
      ? body.nextExpectedRanges
      : null;
  const match =
    Array.isArray(ranges) && typeof ranges[0] === "string" ? /^(\d+)/.exec(ranges[0]) : null;
  if (match?.[1] !== undefined) return Number(match[1]);
  return yield* transferError("The upload provider did not return the next expected range.");
});

const uploadPart = Effect.fn("WebProviderTransfer.uploadPart")(function* (input: {
  readonly body: Blob;
  readonly byteSize: number;
  readonly prepared: PreparedStorageUpload;
  readonly range: "EMPTY" | { readonly end: number; readonly start: number } | null;
  readonly uploadFetch: BrowserUploadFetch;
}) {
  const headers = Object.fromEntries(
    input.prepared.upload.headers.map(({ name, value }) => [name, value]),
  );
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      input.uploadFetch(input.prepared.upload.url, {
        method: input.prepared.upload.method,
        headers:
          input.range === null
            ? headers
            : input.range === "EMPTY"
              ? { ...headers, "Content-Range": "bytes */0" }
              : {
                  ...headers,
                  "Content-Range": `bytes ${input.range.start}-${input.range.end}/${input.byteSize}`,
                },
        body: input.body,
        redirect: "error",
        signal,
      }),
    catch: (cause) => transferError("Could not reach the upload provider.", cause),
  });
  if (!response.ok && response.status !== 202 && response.status !== 308) {
    return yield* transferError(`The upload provider rejected the file (${response.status}).`);
  }
  return response;
});

export const uploadPreparedBrowserContent = Effect.fn("WebProviderTransfer.uploadPreparedContent")(
  function* (
    input: {
      readonly content: Blob;
      readonly prepared: PreparedStorageUpload;
    },
    uploadFetch: BrowserUploadFetch = browserUploadFetch,
  ) {
    const { content, prepared } = input;
    if (!isSupportedProviderUploadTarget(prepared.storageProvider, prepared.upload.url)) {
      return yield* transferError("The upload provider returned an unsupported Web target.");
    }

    if (prepared.upload.strategy.type === "single_request") {
      const response = yield* uploadPart({
        body: content,
        byteSize: content.size,
        prepared,
        range: null,
        uploadFetch,
      });
      if (response.status === 202 || response.status === 308) {
        return yield* transferError("The upload provider did not confirm completion.");
      }
      return { storageObjectId: yield* responseObjectId(response, prepared) };
    }

    const { maxPartByteSize, partByteMultiple } = prepared.upload.strategy;
    const partByteSize = Math.floor(maxPartByteSize / partByteMultiple) * partByteMultiple;
    if (partByteSize < 1) {
      return yield* transferError("The upload provider returned an invalid part size.");
    }

    if (content.size === 0) {
      const response = yield* uploadPart({
        body: content,
        byteSize: 0,
        prepared,
        range: "EMPTY",
        uploadFetch,
      });
      if (response.status === 202 || response.status === 308) {
        return yield* transferError("The upload provider did not confirm completion.");
      }
      return { storageObjectId: yield* responseObjectId(response, prepared) };
    }

    let start = 0;
    while (start < content.size) {
      const end = Math.min(start + partByteSize, content.size) - 1;
      const response = yield* uploadPart({
        body: content.slice(start, end + 1),
        byteSize: content.size,
        prepared,
        range: { end, start },
        uploadFetch,
      });
      if (response.status === 202 || response.status === 308) {
        const nextStart = yield* nextExpectedStart(response);
        if (nextStart <= start) {
          return yield* transferError("The upload session stopped advancing.");
        }
        start = nextStart;
        continue;
      }
      if (end !== content.size - 1) {
        return yield* transferError(
          "The upload provider completed before receiving the whole file.",
        );
      }
      return { storageObjectId: yield* responseObjectId(response, prepared) };
    }
    return yield* transferError("The upload session ended before completion.");
  },
);
