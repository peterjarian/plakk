import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  type DeleteStorageObjectInput,
  StorageProviderError,
  StorageObjectNotFoundError,
  type DownloadStorageObjectInput,
  type GetStorageObjectUrlInput,
  type PreparedStorageUpload,
  type PrepareStorageUploadInput,
  type StorageProviderDestination,
} from "../types.ts";
import type { StorageProviderAdapter } from "../StorageProvider.ts";
import { readStorageObjectBytes } from "../readStorageObjectBytes.ts";

const ONE_DRIVE_ROOT_URL = "https://graph.microsoft.com/v1.0/me/drive/root:";
const ONE_DRIVE_ITEMS_URL = "https://graph.microsoft.com/v1.0/me/drive/items";
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
const OneDriveDownload = Schema.Struct({ "@microsoft.graph.downloadUrl": Schema.String });

const encodeOneDrivePath = (fileName: string) =>
  fileName
    .split("/")
    .filter((segment) => segment !== "")
    .map(encodeURIComponent)
    .join("/");

const providerError = (
  input: Pick<PrepareStorageUploadInput, "storageProvider">,
  message: string,
  cause?: unknown,
): StorageProviderError =>
  new StorageProviderError({ storageProvider: input.storageProvider, message, cause });

export const OneDriveStorageProvider = {
  storageProvider: "ONE_DRIVE",
  deleteObject: Effect.fn("OneDriveStorageProvider.deleteObject")(function* (
    input: DeleteStorageObjectInput,
  ): Effect.fn.Return<void, StorageProviderError, HttpClient.HttpClient> {
    const request = HttpClientRequest.delete(
      `${ONE_DRIVE_ITEMS_URL}/${encodeURIComponent(input.storageObjectId)}`,
    ).pipe(HttpClientRequest.bearerToken(input.accessToken));
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Could not delete the stored object.", cause),
      ),
    );
    if (response.status === 404 || (response.status >= 200 && response.status < 300)) return;
    return yield* providerError(input, `Stored object deletion failed: ${response.status}`);
  }),
  getDestination: () =>
    Effect.succeed({ url: "https://onedrive.live.com/" } satisfies StorageProviderDestination),
  prepareUpload: Effect.fn("OneDriveStorageProvider.prepareUpload")(function* (
    input: PrepareStorageUploadInput,
  ): Effect.fn.Return<PreparedStorageUpload, StorageProviderError, HttpClient.HttpClient> {
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
    const request = HttpClientRequest.post(
      `${ONE_DRIVE_ROOT_URL}/${path}:/createUploadSession`,
    ).pipe(
      HttpClientRequest.bearerToken(input.accessToken),
      HttpClientRequest.bodyText(body, "application/json"),
    );
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError((cause) =>
        providerError(input, "OneDrive upload session request failed.", cause),
      ),
    );

    if (response.status < 200 || response.status >= 300) {
      return yield* providerError(input, `OneDrive upload session failed: ${response.status}`);
    }

    const session = yield* HttpClientResponse.schemaBodyJson(OneDriveUploadSession)(response).pipe(
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
  }),
  download: Effect.fn("OneDriveStorageProvider.download")(function* (
    input: DownloadStorageObjectInput,
  ): Effect.fn.Return<
    Uint8Array,
    StorageProviderError | StorageObjectNotFoundError,
    HttpClient.HttpClient
  > {
    const request = HttpClientRequest.get(
      `${ONE_DRIVE_ITEMS_URL}/${encodeURIComponent(input.storageObjectId)}/content`,
    ).pipe(HttpClientRequest.bearerToken(input.accessToken));
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Could not download the stored object.", cause),
      ),
    );
    if (response.status === 404) {
      return yield* new StorageObjectNotFoundError({
        storageProvider: input.storageProvider,
        message: "The stored object no longer exists.",
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* providerError(input, `Stored object download failed: ${response.status}`);
    }
    return yield* readStorageObjectBytes(response, input);
  }),
  getDownloadUrl: Effect.fn("OneDriveStorageProvider.getDownloadUrl")(function* (
    input: GetStorageObjectUrlInput,
  ): Effect.fn.Return<
    string,
    StorageProviderError | StorageObjectNotFoundError,
    HttpClient.HttpClient
  > {
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(
        `${ONE_DRIVE_ITEMS_URL}/${encodeURIComponent(input.storageObjectId)}`,
      ).pipe(
        HttpClientRequest.bearerToken(input.accessToken),
        HttpClientRequest.setUrlParam("$select", "@microsoft.graph.downloadUrl"),
      ),
    ).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Could not get the stored object URL.", cause),
      ),
    );
    if (response.status === 404) {
      return yield* new StorageObjectNotFoundError({
        storageProvider: input.storageProvider,
        message: "The stored object no longer exists.",
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* providerError(input, `Stored object URL failed: ${response.status}`);
    }
    return yield* HttpClientResponse.schemaBodyJson(OneDriveDownload)(response).pipe(
      Effect.map((download) => download["@microsoft.graph.downloadUrl"]),
      Effect.mapError((cause) =>
        providerError(input, "Stored object response did not include downloadUrl.", cause),
      ),
    );
  }),
} satisfies StorageProviderAdapter;
