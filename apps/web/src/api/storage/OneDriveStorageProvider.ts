import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  StorageProviderError,
  type PreparedStorageUpload,
  type PrepareStorageUploadInput,
  type StorageProviderAdapter,
} from "./types.ts";

const ONE_DRIVE_ROOT_URL = "https://graph.microsoft.com/v1.0/me/drive/root:";
const ONE_DRIVE_PART_BYTE_MULTIPLE = 320 * 1024;
const ONE_DRIVE_MAX_PART_BYTE_SIZE = 191 * ONE_DRIVE_PART_BYTE_MULTIPLE;
const OneDriveUploadSessionRequest = Schema.fromJsonString(
  Schema.Struct({
    item: Schema.Struct({
      "@microsoft.graph.conflictBehavior": Schema.Literal("rename"),
    }),
  }),
);
const OneDriveUploadSession = Schema.Struct({
  uploadUrl: Schema.String,
  expirationDateTime: Schema.String,
});

const encodeOneDrivePath = (fileName: string) =>
  fileName
    .split("/")
    .filter((segment) => segment !== "")
    .map(encodeURIComponent)
    .join("/");

const providerError = (
  input: PrepareStorageUploadInput,
  message: string,
  cause?: unknown,
): StorageProviderError =>
  new StorageProviderError({ storageProvider: input.storageProvider, message, cause });

const prepareUpload = Effect.fn("OneDriveStorageProvider.prepareUpload")(function* (
  input: PrepareStorageUploadInput,
): Effect.fn.Return<PreparedStorageUpload, StorageProviderError> {
  if (input.byteSize < 1) {
    return yield* providerError(input, "OneDrive upload sessions require a positive byte size.");
  }

  const path = encodeOneDrivePath(input.fileName);
  if (path === "") return yield* providerError(input, "OneDrive file name is required.");

  const body = yield* Schema.encodeEffect(OneDriveUploadSessionRequest)({
    item: {
      "@microsoft.graph.conflictBehavior": "rename",
    },
  }).pipe(
    Effect.mapError((cause) =>
      providerError(input, "OneDrive upload session request was invalid.", cause),
    ),
  );
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(`${ONE_DRIVE_ROOT_URL}/${path}:/createUploadSession`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body,
      }),
    catch: (cause) => providerError(input, "OneDrive upload session request failed.", cause),
  });

  if (!response.ok) {
    return yield* providerError(input, `OneDrive upload session failed: ${response.status}`);
  }

  const result = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: (cause) => providerError(input, "OneDrive upload session response was not JSON.", cause),
  });
  const session = yield* Schema.decodeUnknownEffect(OneDriveUploadSession)(result).pipe(
    Effect.mapError((cause) =>
      providerError(input, "OneDrive upload session response did not include uploadUrl.", cause),
    ),
  );

  return {
    storageProvider: input.storageProvider,
    storageObjectId: null,
    upload: {
      method: "PUT",
      url: session.uploadUrl,
      headers: [],
      strategy: {
        type: "byte_range",
        maxPartByteSize: ONE_DRIVE_MAX_PART_BYTE_SIZE,
        partByteMultiple: ONE_DRIVE_PART_BYTE_MULTIPLE,
      },
    },
    expiresAt: session.expirationDateTime,
  };
});

export const OneDriveStorageProvider = {
  prepareUpload,
} satisfies StorageProviderAdapter;
