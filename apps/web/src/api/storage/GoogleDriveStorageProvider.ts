import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  StorageProviderError,
  type PreparedStorageUpload,
  type PrepareStorageUploadInput,
  type StorageProviderDestination,
} from "./types.ts";
import type { StorageProviderAdapter } from "./StorageProvider.ts";

const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_RESUMABLE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DRIVE_FOLDER_NAME = "Plakk";
const GoogleDriveUploadMetadata = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    mimeType: Schema.String,
    parents: Schema.Array(Schema.String),
  }),
);
const GoogleDriveFolderList = Schema.Struct({
  files: Schema.Array(Schema.Struct({ id: Schema.String })),
});
const GoogleDriveFolder = Schema.Struct({ id: Schema.String });

const providerError = (
  input: Pick<PrepareStorageUploadInput, "storageProvider">,
  message: string,
  cause?: unknown,
): StorageProviderError =>
  new StorageProviderError({ storageProvider: input.storageProvider, message, cause });

type GoogleDriveFolderDestination = StorageProviderDestination & { readonly id: string };

const folderUrl = (id: string) =>
  `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;

const getPlakkFolder = Effect.fn("GoogleDriveStorageProvider.getPlakkFolder")(function* (
  accessToken: string,
): Effect.fn.Return<GoogleDriveFolderDestination, StorageProviderError, HttpClient.HttpClient> {
  const listRequest = HttpClientRequest.get(GOOGLE_DRIVE_FILES_URL).pipe(
    HttpClientRequest.bearerToken(accessToken),
    HttpClientRequest.setUrlParam(
      "q",
      `mimeType = '${GOOGLE_DRIVE_FOLDER_MIME_TYPE}' and name = '${GOOGLE_DRIVE_FOLDER_NAME}' and trashed = false`,
    ),
    HttpClientRequest.setUrlParam("fields", "files(id)"),
    HttpClientRequest.setUrlParam("pageSize", "1"),
  );
  const listResponse = yield* HttpClient.execute(listRequest).pipe(
    Effect.mapError((cause) =>
      providerError({ storageProvider: "GOOGLE_DRIVE" }, "Could not find the Plakk folder.", cause),
    ),
  );
  if (listResponse.status < 200 || listResponse.status >= 300) {
    return yield* providerError(
      { storageProvider: "GOOGLE_DRIVE" },
      `Could not find the Plakk folder: ${listResponse.status}`,
    );
  }
  const folderList = yield* HttpClientResponse.schemaBodyJson(GoogleDriveFolderList)(
    listResponse,
  ).pipe(
    Effect.mapError((cause) =>
      providerError(
        { storageProvider: "GOOGLE_DRIVE" },
        "The Plakk folder response was invalid.",
        cause,
      ),
    ),
  );
  const existing = folderList.files[0];
  if (existing !== undefined) return { id: existing.id, url: folderUrl(existing.id) };

  const createBody = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ name: Schema.String, mimeType: Schema.String })),
  )({ name: GOOGLE_DRIVE_FOLDER_NAME, mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE }).pipe(
    Effect.mapError((cause) =>
      providerError(
        { storageProvider: "GOOGLE_DRIVE" },
        "Could not create the Plakk folder.",
        cause,
      ),
    ),
  );
  const createRequest = HttpClientRequest.post(GOOGLE_DRIVE_FILES_URL).pipe(
    HttpClientRequest.bearerToken(accessToken),
    HttpClientRequest.setUrlParam("fields", "id"),
    HttpClientRequest.bodyText(createBody, "application/json; charset=UTF-8"),
  );
  const createResponse = yield* HttpClient.execute(createRequest).pipe(
    Effect.mapError((cause) =>
      providerError(
        { storageProvider: "GOOGLE_DRIVE" },
        "Could not create the Plakk folder.",
        cause,
      ),
    ),
  );
  if (createResponse.status < 200 || createResponse.status >= 300) {
    return yield* providerError(
      { storageProvider: "GOOGLE_DRIVE" },
      `Could not create the Plakk folder: ${createResponse.status}`,
    );
  }
  const folder = yield* HttpClientResponse.schemaBodyJson(GoogleDriveFolder)(createResponse).pipe(
    Effect.mapError((cause) =>
      providerError(
        { storageProvider: "GOOGLE_DRIVE" },
        "The new Plakk folder response was invalid.",
        cause,
      ),
    ),
  );
  return { id: folder.id, url: folderUrl(folder.id) };
});

export const GoogleDriveStorageProvider = {
  storageProvider: "GOOGLE_DRIVE",
  getDestination: Effect.fn("GoogleDriveStorageProvider.getDestination")(function* (input: {
    readonly accessToken: string;
  }) {
    const folder = yield* getPlakkFolder(input.accessToken);
    return { url: folder.url } satisfies StorageProviderDestination;
  }),
  prepareUpload: Effect.fn("GoogleDriveStorageProvider.prepareUpload")(function* (
    input: PrepareStorageUploadInput,
  ): Effect.fn.Return<PreparedStorageUpload, StorageProviderError, HttpClient.HttpClient> {
    const contentType = input.contentType ?? "application/octet-stream";
    const folder = yield* getPlakkFolder(input.accessToken);
    const body = yield* Schema.encodeEffect(GoogleDriveUploadMetadata)({
      name: input.fileName,
      mimeType: contentType,
      parents: [folder.id],
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
