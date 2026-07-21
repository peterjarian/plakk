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

const DROPBOX_TEMPORARY_UPLOAD_LINK_URL =
  "https://api.dropboxapi.com/2/files/get_temporary_upload_link";
const DROPBOX_DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download";
const DROPBOX_TEMPORARY_LINK_URL = "https://api.dropboxapi.com/2/files/get_temporary_link";
const DROPBOX_DELETE_URL = "https://api.dropboxapi.com/2/files/delete_v2";
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
const DropboxDownloadArg = Schema.fromJsonString(Schema.Struct({ path: Schema.String }));
const DropboxTemporaryLinkRequest = Schema.fromJsonString(Schema.Struct({ path: Schema.String }));
const DropboxTemporaryLink = Schema.Struct({ link: Schema.String });
const DropboxDeleteRequest = Schema.fromJsonString(Schema.Struct({ path: Schema.String }));
const DropboxDownloadError = Schema.Struct({ error_summary: Schema.String });

const asDropboxPath = (snippetId: string, fileName: string) =>
  `/${snippetId}/${fileName.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;

const providerError = (
  input: Pick<PrepareStorageUploadInput, "storageProvider">,
  message: string,
  cause?: unknown,
): StorageProviderError =>
  new StorageProviderError({ storageProvider: input.storageProvider, message, cause });

export const DropboxStorageProvider = {
  storageProvider: "DROPBOX",
  deleteObject: Effect.fn("DropboxStorageProvider.deleteObject")(function* (
    input: DeleteStorageObjectInput,
  ): Effect.fn.Return<void, StorageProviderError, HttpClient.HttpClient> {
    const body = yield* Schema.encodeEffect(DropboxDeleteRequest)({
      path: input.storageObjectId,
    }).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Stored object deletion request was invalid.", cause),
      ),
    );
    const request = HttpClientRequest.post(DROPBOX_DELETE_URL).pipe(
      HttpClientRequest.bearerToken(input.accessToken),
      HttpClientRequest.bodyText(body, "application/json"),
    );
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Could not delete the stored object.", cause),
      ),
    );
    if (response.status >= 200 && response.status < 300) return;
    return yield* providerError(input, `Stored object deletion failed: ${response.status}`);
  }),
  getDestination: () =>
    Effect.succeed({ url: "https://www.dropbox.com/home" } satisfies StorageProviderDestination),
  prepareUpload: Effect.fn("DropboxStorageProvider.prepareUpload")(function* (
    input: PrepareStorageUploadInput,
  ): Effect.fn.Return<PreparedStorageUpload, StorageProviderError, HttpClient.HttpClient> {
    const path = asDropboxPath(input.snippetId, input.fileName);
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
    const request = HttpClientRequest.post(DROPBOX_TEMPORARY_UPLOAD_LINK_URL).pipe(
      HttpClientRequest.bearerToken(input.accessToken),
      HttpClientRequest.bodyText(body, "application/json"),
    );
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Dropbox upload link request failed.", cause),
      ),
    );

    if (response.status < 200 || response.status >= 300) {
      return yield* providerError(input, `Dropbox upload link failed: ${response.status}`);
    }

    const decoded = yield* HttpClientResponse.schemaBodyJson(DropboxTemporaryUploadLink)(
      response,
    ).pipe(
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
  }),
  download: Effect.fn("DropboxStorageProvider.download")(function* (
    input: DownloadStorageObjectInput,
  ): Effect.fn.Return<
    Uint8Array,
    StorageProviderError | StorageObjectNotFoundError,
    HttpClient.HttpClient
  > {
    const arg = yield* Schema.encodeEffect(DropboxDownloadArg)({
      path: input.storageObjectId,
    }).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Dropbox download request was invalid.", cause),
      ),
    );
    const request = HttpClientRequest.post(DROPBOX_DOWNLOAD_URL).pipe(
      HttpClientRequest.bearerToken(input.accessToken),
      HttpClientRequest.setHeader("Dropbox-API-Arg", arg),
    );
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Could not download the stored object.", cause),
      ),
    );
    if (response.status === 409) {
      const error = yield* HttpClientResponse.schemaBodyJson(DropboxDownloadError)(response).pipe(
        Effect.mapError((cause) =>
          providerError(input, "Dropbox download error response was invalid.", cause),
        ),
      );
      if (error.error_summary.startsWith("path/not_found/")) {
        return yield* new StorageObjectNotFoundError({
          storageProvider: input.storageProvider,
          message: "The stored object no longer exists.",
        });
      }
      return yield* providerError(input, "Stored object download failed: 409");
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* providerError(input, `Stored object download failed: ${response.status}`);
    }
    return yield* readStorageObjectBytes(response, input);
  }),
  getDownloadUrl: Effect.fn("DropboxStorageProvider.getDownloadUrl")(function* (
    input: GetStorageObjectUrlInput,
  ): Effect.fn.Return<
    string,
    StorageProviderError | StorageObjectNotFoundError,
    HttpClient.HttpClient
  > {
    const body = yield* Schema.encodeEffect(DropboxTemporaryLinkRequest)({
      path: input.storageObjectId,
    }).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Stored object URL request was invalid.", cause),
      ),
    );
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(DROPBOX_TEMPORARY_LINK_URL).pipe(
        HttpClientRequest.bearerToken(input.accessToken),
        HttpClientRequest.bodyText(body, "application/json"),
      ),
    ).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Could not get the stored object URL.", cause),
      ),
    );
    if (response.status === 409) {
      return yield* new StorageObjectNotFoundError({
        storageProvider: input.storageProvider,
        message: "The stored object no longer exists.",
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* providerError(input, `Stored object URL failed: ${response.status}`);
    }
    return yield* HttpClientResponse.schemaBodyJson(DropboxTemporaryLink)(response).pipe(
      Effect.map((download) => download.link),
      Effect.mapError((cause) =>
        providerError(input, "Stored object response did not include a temporary link.", cause),
      ),
    );
  }),
} satisfies StorageProviderAdapter;
