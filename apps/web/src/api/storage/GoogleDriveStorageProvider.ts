import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Headers, HttpClient, HttpClientRequest } from "effect/unstable/http";

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

export const GoogleDriveStorageProvider = {
  storageProvider: "GOOGLE_DRIVE",
  prepareUpload: Effect.fn("GoogleDriveStorageProvider.prepareUpload")(function* (
    input: PrepareStorageUploadInput,
  ): Effect.fn.Return<PreparedStorageUpload, StorageProviderError, HttpClient.HttpClient> {
    const contentType = input.contentType ?? "application/octet-stream";
    const body = yield* Schema.encodeEffect(GoogleDriveUploadMetadata)({
      name: input.fileName,
      mimeType: contentType,
    }).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Google Drive upload session request was invalid.", cause),
      ),
    );
    const request = HttpClientRequest.post(GOOGLE_DRIVE_RESUMABLE_UPLOAD_URL).pipe(
      HttpClientRequest.bearerToken(input.accessToken),
      HttpClientRequest.setHeader("X-Upload-Content-Length", String(input.byteSize)),
      HttpClientRequest.setHeader("X-Upload-Content-Type", contentType),
      HttpClientRequest.bodyText(body, "application/json; charset=UTF-8"),
    );
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError((cause) =>
        providerError(input, "Google Drive upload session request failed.", cause),
      ),
    );
    const url = Option.getOrNull(Headers.get(response.headers, "location"));

    if (response.status < 200 || response.status >= 300) {
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
  }),
} satisfies StorageProviderAdapter;
