import { StorageProviderLiteral, type StorageProvider as StorageProviderName } from "@plakk/shared";
import type { PreparedStorageUpload, StorageProviderStatus } from "@plakk/shared/PlakkApi";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Headers, type HttpClient, type HttpClientResponse } from "effect/unstable/http";

export type { PreparedStorageUpload };

export class StorageProviderError extends Schema.TaggedErrorClass<StorageProviderError>()(
  "StorageProviderError",
  {
    storageProvider: StorageProviderLiteral,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class StorageObjectNotFoundError extends Schema.TaggedErrorClass<StorageObjectNotFoundError>()(
  "StorageObjectNotFoundError",
  {
    storageProvider: StorageProviderLiteral,
    message: Schema.String,
  },
) {}

export type StorageProviderDestination = {
  readonly url: string;
};

export type PrepareStorageUploadInput = {
  readonly accessToken: string;
  readonly snippetId: string;
  readonly storageProvider: StorageProviderName;
  readonly fileName: string;
  readonly byteSize: number;
  readonly contentType: string | null;
};

export type DownloadStorageObjectInput = {
  readonly accessToken: string;
  readonly storageProvider: StorageProviderName;
  readonly storageObjectId: string;
  readonly expectedByteSize: number;
};

export type GetStorageObjectUrlInput = Omit<DownloadStorageObjectInput, "expectedByteSize">;

export type DeleteStorageObjectInput = GetStorageObjectUrlInput;

export type StorageDownloadTarget = {
  readonly url: string;
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
};

export type ConnectedStorageInput = {
  readonly storageProvider: PrepareStorageUploadInput["storageProvider"];
  readonly workosUserId: string;
};

export type BeginStorageAuthorizationInput = ConnectedStorageInput & {
  readonly returnTo: string;
};

export class StorageNotConnectedError extends Schema.TaggedErrorClass<StorageNotConnectedError>()(
  "StorageNotConnectedError",
  { message: Schema.String },
) {}

export class StorageNeedsReauthorizationError extends Schema.TaggedErrorClass<StorageNeedsReauthorizationError>()(
  "StorageNeedsReauthorizationError",
  { message: Schema.String },
) {}

export class StorageCredentialsError extends Schema.TaggedErrorClass<StorageCredentialsError>()(
  "StorageCredentialsError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export type StorageProviderOperationError =
  | StorageNotConnectedError
  | StorageNeedsReauthorizationError
  | StorageCredentialsError
  | StorageProviderError;

export type StorageUploadError = StorageProviderOperationError;
export type StorageDeletionError = StorageProviderOperationError;
export type StorageDownloadError = StorageUploadError | StorageObjectNotFoundError;

export type StorageProviderAdapter = {
  readonly storageProvider: PrepareStorageUploadInput["storageProvider"];
  readonly getDestination: (
    input: Pick<PrepareStorageUploadInput, "accessToken">,
  ) => Effect.Effect<StorageProviderDestination, StorageProviderError, HttpClient.HttpClient>;
  readonly prepareUpload: (
    input: PrepareStorageUploadInput,
  ) => Effect.Effect<PreparedStorageUpload, StorageProviderError, HttpClient.HttpClient>;
  readonly download: (
    input: DownloadStorageObjectInput,
  ) => Effect.Effect<
    Uint8Array,
    StorageProviderError | StorageObjectNotFoundError,
    HttpClient.HttpClient
  >;
  readonly getDownloadUrl: (
    input: GetStorageObjectUrlInput,
  ) => Effect.Effect<
    string,
    StorageProviderError | StorageObjectNotFoundError,
    HttpClient.HttpClient
  >;
  readonly getDownloadTarget?: (
    input: GetStorageObjectUrlInput,
  ) => Effect.Effect<StorageDownloadTarget, StorageProviderError, HttpClient.HttpClient>;
  readonly deleteObject: (
    input: DeleteStorageObjectInput,
  ) => Effect.Effect<void, StorageProviderError, HttpClient.HttpClient>;
};

export const getProviderSlug = (provider: StorageProviderName) => {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return "google-drive";
    case "ONE_DRIVE":
      return "microsoft-onedrive";
    case "DROPBOX":
      return "dropbox";
  }
};

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

export class StorageProvider extends Context.Service<
  StorageProvider,
  {
    readonly beginAuthorization: (
      input: BeginStorageAuthorizationInput,
    ) => Effect.Effect<{ readonly url: string }, StorageCredentialsError>;
    readonly disconnect: (
      input: ConnectedStorageInput,
    ) => Effect.Effect<void, StorageCredentialsError>;
    readonly ensureConnected: (
      input: ConnectedStorageInput,
    ) => Effect.Effect<
      void,
      StorageCredentialsError | StorageNotConnectedError | StorageNeedsReauthorizationError
    >;
    readonly prepareUpload: (
      input: Omit<PrepareStorageUploadInput, "accessToken"> & { readonly workosUserId: string },
    ) => Effect.Effect<PreparedStorageUpload, StorageUploadError>;
    readonly getDestinationUrl: (
      input: ConnectedStorageInput,
    ) => Effect.Effect<string, StorageUploadError>;
    readonly getLinkedProvider: (
      workosUserId: string,
    ) => Effect.Effect<StorageProviderName | null, StorageCredentialsError>;
    readonly getStatus: (
      input: ConnectedStorageInput,
    ) => Effect.Effect<StorageProviderStatus, StorageUploadError>;
    readonly downloadObject: (
      input: Omit<DownloadStorageObjectInput, "accessToken"> & { readonly workosUserId: string },
    ) => Effect.Effect<Uint8Array, StorageDownloadError>;
    readonly getDownloadUrl: (
      input: Omit<GetStorageObjectUrlInput, "accessToken"> & { readonly workosUserId: string },
    ) => Effect.Effect<string, StorageDownloadError>;
    readonly getDownloadTarget: (
      input: Omit<GetStorageObjectUrlInput, "accessToken"> & { readonly workosUserId: string },
    ) => Effect.Effect<StorageDownloadTarget, StorageDownloadError>;
    readonly deleteObject: (
      input: Omit<DeleteStorageObjectInput, "accessToken"> & { readonly workosUserId: string },
    ) => Effect.Effect<void, StorageDeletionError>;
  }
>()("@plakk/backend/storage/StorageProvider") {}
