import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  StorageProviderError,
  type PreparedStorageUpload,
  type PrepareStorageUploadInput,
  type StorageProviderAdapter,
} from "./types.ts";

const DROPBOX_TEMPORARY_UPLOAD_LINK_URL =
  "https://api.dropboxapi.com/2/files/get_temporary_upload_link";
const DropboxTemporaryUploadLinkRequest = Schema.fromJsonString(
  Schema.Struct({
    commit_info: Schema.Struct({
      path: Schema.String,
      mode: Schema.Literal("add"),
      autorename: Schema.Boolean,
      mute: Schema.Boolean,
      strict_conflict: Schema.Boolean,
    }),
  }),
);
const DropboxTemporaryUploadLink = Schema.Struct({ link: Schema.String });

const asDropboxPath = (fileName: string) => (fileName.startsWith("/") ? fileName : `/${fileName}`);

const providerError = (
  input: PrepareStorageUploadInput,
  message: string,
  cause?: unknown,
): StorageProviderError =>
  new StorageProviderError({ storageProvider: input.storageProvider, message, cause });

const prepareUpload = Effect.fn("DropboxStorageProvider.prepareUpload")(function* (
  input: PrepareStorageUploadInput,
): Effect.fn.Return<PreparedStorageUpload, StorageProviderError> {
  const path = asDropboxPath(input.fileName);
  const body = yield* Schema.encodeEffect(DropboxTemporaryUploadLinkRequest)({
    commit_info: {
      path,
      mode: "add",
      autorename: false,
      mute: false,
      strict_conflict: false,
    },
  }).pipe(
    Effect.mapError((cause) =>
      providerError(input, "Dropbox upload link request was invalid.", cause),
    ),
  );
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(DROPBOX_TEMPORARY_UPLOAD_LINK_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body,
      }),
    catch: (cause) => providerError(input, "Dropbox upload link request failed.", cause),
  });

  if (!response.ok) {
    return yield* providerError(input, `Dropbox upload link failed: ${response.status}`);
  }

  const result = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: (cause) => providerError(input, "Dropbox upload link response was not JSON.", cause),
  });
  const decoded = yield* Schema.decodeUnknownEffect(DropboxTemporaryUploadLink)(result).pipe(
    Effect.mapError((cause) =>
      providerError(input, "Dropbox upload link response did not include link.", cause),
    ),
  );

  return {
    storageProvider: input.storageProvider,
    storageObjectId: path,
    upload: {
      method: "POST",
      url: decoded.link,
      headers: [{ name: "Content-Type", value: "application/octet-stream" }],
      strategy: { type: "single_request" },
    },
    expiresAt: null,
  };
});

export const DropboxStorageProvider = {
  prepareUpload,
} satisfies StorageProviderAdapter;
