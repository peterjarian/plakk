import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient } from "effect/unstable/http";

import { makeWorkOSClient } from "../auth/makeWorkOSClient.ts";
import { getProviderSlug } from "./getProviderSlug.ts";
import { DropboxStorageProvider } from "./providers/DropboxStorageProvider.ts";
import { GoogleDriveStorageProvider } from "./providers/GoogleDriveStorageProvider.ts";
import { OneDriveStorageProvider } from "./providers/OneDriveStorageProvider.ts";
import {
  type ConnectedStorageInput,
  StorageCredentialsError,
  type StorageDownloadError,
  StorageNeedsReauthorizationError,
  StorageNotConnectedError,
  type StorageProviderAdapter,
  StorageProviderService,
  type StorageUploadError,
} from "./StorageProvider.ts";
import { StorageProviderError } from "./types.ts";
import type {
  PreparedStorageUpload,
  PrepareStorageUploadInput,
  DownloadStorageObjectInput,
  GetStorageObjectUrlInput,
  StorageDownloadTarget,
} from "./types.ts";

type ConnectedStorageToken = {
  readonly accessToken: string;
};

const storageProviderAdapters = {
  [GoogleDriveStorageProvider.storageProvider]: GoogleDriveStorageProvider,
  [OneDriveStorageProvider.storageProvider]: OneDriveStorageProvider,
  [DropboxStorageProvider.storageProvider]: DropboxStorageProvider,
} satisfies Record<PrepareStorageUploadInput["storageProvider"], StorageProviderAdapter>;

export const StorageProviderLive = Layer.effect(
  StorageProviderService,
  Effect.gen(function* () {
    const { apiKey, clientId } = yield* Effect.all({
      apiKey: Config.redacted("WORKOS_API_KEY"),
      clientId: Config.string("WORKOS_CLIENT_ID"),
    }).pipe(Effect.orDie);
    const workos = yield* makeWorkOSClient(Redacted.value(apiKey), clientId);
    const httpClient = yield* HttpClient.HttpClient;

    const getConnectedToken = Effect.fn("StorageProviderService.getConnectedToken")(function* (
      input: ConnectedStorageInput,
    ): Effect.fn.Return<
      ConnectedStorageToken,
      StorageCredentialsError | StorageNotConnectedError | StorageNeedsReauthorizationError
    > {
      const token = yield* Effect.tryPromise({
        try: () =>
          workos.pipes.getAccessToken({
            provider: getProviderSlug(input.storageProvider),
            userId: input.workosUserId,
          }),
        catch: (cause) =>
          new StorageCredentialsError({
            message: "Could not get storage credentials.",
            cause,
          }),
      });

      if (!token.active) {
        if (token.error === "needs_reauthorization") {
          return yield* new StorageNeedsReauthorizationError({
            message: "Reconnect storage to upload files.",
          });
        }

        return yield* new StorageNotConnectedError({
          message: "Connect storage to upload files.",
        });
      }

      return { accessToken: token.accessToken.accessToken };
    });

    const ensureConnected = Effect.fn("StorageProviderService.ensureConnected")(function* (
      input: ConnectedStorageInput,
    ) {
      yield* getConnectedToken(input);
    });

    const prepareUpload = Effect.fn("StorageProviderService.prepareUpload")(function* (
      input: Omit<PrepareStorageUploadInput, "accessToken"> & { readonly workosUserId: string },
    ): Effect.fn.Return<PreparedStorageUpload, StorageUploadError> {
      const token = yield* getConnectedToken(input);
      const providerInput = { ...input, accessToken: token.accessToken };
      return yield* storageProviderAdapters[input.storageProvider]
        .prepareUpload(providerInput)
        .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    });

    const getDestinationUrl = Effect.fn("StorageProviderService.getDestinationUrl")(function* (
      input: ConnectedStorageInput,
    ): Effect.fn.Return<string, StorageUploadError> {
      const token = yield* getConnectedToken(input);
      const destination = yield* storageProviderAdapters[input.storageProvider]
        .getDestination(token)
        .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      return destination.url;
    });

    const downloadObject = Effect.fn("StorageProviderService.downloadObject")(function* (
      input: Omit<DownloadStorageObjectInput, "accessToken"> & {
        readonly workosUserId: string;
      },
    ): Effect.fn.Return<Uint8Array, StorageDownloadError> {
      const token = yield* getConnectedToken(input);
      const bytes = yield* storageProviderAdapters[input.storageProvider]
        .download({ ...input, accessToken: token.accessToken })
        .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      if (bytes.byteLength !== input.expectedByteSize) {
        return yield* new StorageProviderError({
          storageProvider: input.storageProvider,
          message: "Stored object size does not match snippet metadata.",
        });
      }
      return bytes;
    });

    const getDownloadUrl = Effect.fn("StorageProviderService.getDownloadUrl")(function* (
      input: Omit<GetStorageObjectUrlInput, "accessToken"> & { readonly workosUserId: string },
    ): Effect.fn.Return<string, StorageDownloadError> {
      const token = yield* getConnectedToken(input);
      return yield* storageProviderAdapters[input.storageProvider]
        .getDownloadUrl({ ...input, accessToken: token.accessToken })
        .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    });

    const getDownloadTarget = Effect.fn("StorageProviderService.getDownloadTarget")(function* (
      input: Omit<GetStorageObjectUrlInput, "accessToken"> & {
        readonly workosUserId: string;
      },
    ): Effect.fn.Return<StorageDownloadTarget, StorageDownloadError> {
      const token = yield* getConnectedToken(input);
      const adapter: StorageProviderAdapter = storageProviderAdapters[input.storageProvider];
      if (adapter.getDownloadTarget !== undefined) {
        return yield* adapter
          .getDownloadTarget({ ...input, accessToken: token.accessToken })
          .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      }
      const url = yield* adapter
        .getDownloadUrl({ ...input, accessToken: token.accessToken })
        .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      return { url, headers: [] };
    });

    return StorageProviderService.of({
      ensureConnected,
      prepareUpload,
      getDestinationUrl,
      downloadObject,
      getDownloadUrl,
      getDownloadTarget,
    });
  }),
);
