import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/unstable/http";

import { StorageProviderError } from "./types.ts";
import type {
  DownloadStorageObjectInput,
  GetStorageObjectUrlInput,
  PreparedStorageUpload,
  PrepareStorageUploadInput,
  StorageDownloadTarget,
  StorageObjectNotFoundError,
  StorageProviderDestination,
} from "./types.ts";

export type ConnectedStorageInput = {
  readonly storageProvider: PrepareStorageUploadInput["storageProvider"];
  readonly workosUserId: string;
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

export type StorageUploadError =
  | StorageNotConnectedError
  | StorageNeedsReauthorizationError
  | StorageCredentialsError
  | StorageProviderError;

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
};

export class StorageProviderService extends Context.Service<
  StorageProviderService,
  {
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
    readonly downloadObject: (
      input: Omit<DownloadStorageObjectInput, "accessToken"> & { readonly workosUserId: string },
    ) => Effect.Effect<Uint8Array, StorageDownloadError>;
    readonly getDownloadUrl: (
      input: Omit<GetStorageObjectUrlInput, "accessToken"> & { readonly workosUserId: string },
    ) => Effect.Effect<string, StorageDownloadError>;
    readonly getDownloadTarget: (
      input: Omit<GetStorageObjectUrlInput, "accessToken"> & { readonly workosUserId: string },
    ) => Effect.Effect<StorageDownloadTarget, StorageDownloadError>;
  }
>()("@plakk/backend/api/storage/StorageProvider/StorageProviderService") {}
