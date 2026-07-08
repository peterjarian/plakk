import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  StorageProviderError,
  type PreparedStorageUpload,
  type PrepareStorageUploadInput,
  type StorageProviderAdapter,
} from "./types.ts";

const GOOGLE_DRIVE_RESUMABLE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id";
const GoogleDriveUploadMetadata = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, mimeType: Schema.String }),
);

const providerError = (
  input: PrepareStorageUploadInput,
  message: string,
  cause?: unknown,
): StorageProviderError =>
  new StorageProviderError({ storageProvider: input.storageProvider, message, cause });

const prepareUpload = Effect.fn("GoogleDriveStorageProvider.prepareUpload")(function* (
  input: PrepareStorageUploadInput,
): Effect.fn.Return<PreparedStorageUpload, StorageProviderError> {
  const contentType = input.contentType ?? "application/octet-stream";
  const body = yield* Schema.encodeEffect(GoogleDriveUploadMetadata)({
    name: input.fileName,
    mimeType: contentType,
  }).pipe(
    Effect.mapError((cause) =>
      providerError(input, "Google Drive upload session request was invalid.", cause),
    ),
  );
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(GOOGLE_DRIVE_RESUMABLE_UPLOAD_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(input.byteSize),
          "X-Upload-Content-Type": contentType,
        },
        body,
      }),
    catch: (cause) => providerError(input, "Google Drive upload session request failed.", cause),
  });
  const url = response.headers.get("Location");

  if (!response.ok) {
    return yield* providerError(input, `Google Drive upload session failed: ${response.status}`);
  }
  if (url === null || url === "") {
    return yield* providerError(
      input,
      "Google Drive upload session response did not include Location.",
    );
  }

  return {
    storageProvider: input.storageProvider,
    storageObjectId: null,
    upload: {
      method: "PUT",
      url,
      headers: [{ name: "Content-Type", value: contentType }],
      strategy: { type: "single_request" },
    },
    expiresAt: null,
  };
});

export const GoogleDriveStorageProvider = {
  prepareUpload,
} satisfies StorageProviderAdapter;
