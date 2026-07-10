import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Headers, type HttpClientResponse } from "effect/unstable/http";

import { StorageProviderError, type DownloadStorageObjectInput } from "./types.ts";

export const readStorageObjectBytes = Effect.fn("readStorageObjectBytes")(function* (
  response: HttpClientResponse.HttpClientResponse,
  input: DownloadStorageObjectInput,
) {
  const contentLength = Option.getOrNull(Headers.get(response.headers, "content-length"));
  if (contentLength !== null && Number(contentLength) !== input.expectedByteSize) {
    return yield* new StorageProviderError({
      storageProvider: input.storageProvider,
      message: "Stored object size does not match snippet metadata.",
    });
  }

  const collected = yield* Stream.runFoldEffect(
    response.stream,
    () => ({ chunks: [] as Array<Uint8Array>, byteSize: 0 }),
    (accumulator, chunk) => {
      const byteSize = accumulator.byteSize + chunk.byteLength;
      if (byteSize > input.expectedByteSize) {
        return Effect.fail(
          new StorageProviderError({
            storageProvider: input.storageProvider,
            message: "Stored object size does not match snippet metadata.",
          }),
        );
      }
      accumulator.chunks.push(chunk);
      return Effect.succeed({ chunks: accumulator.chunks, byteSize });
    },
  ).pipe(
    Effect.mapError((cause) =>
      Schema.is(StorageProviderError)(cause)
        ? cause
        : new StorageProviderError({
            storageProvider: input.storageProvider,
            message: "Could not read the stored object.",
            cause,
          }),
    ),
  );
  if (collected.byteSize !== input.expectedByteSize) {
    return yield* new StorageProviderError({
      storageProvider: input.storageProvider,
      message: "Stored object size does not match snippet metadata.",
    });
  }

  const bytes = new Uint8Array(collected.byteSize);
  let offset = 0;
  for (const chunk of collected.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});
