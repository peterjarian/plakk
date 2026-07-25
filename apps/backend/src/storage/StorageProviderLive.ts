import { STORAGE_PROVIDERS } from "@plakk/shared";
import { WorkOS } from "@workos-inc/node";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { DropboxStorageProvider } from "./providers/DropboxStorageProvider.ts";
import { GoogleDriveStorageProvider } from "./providers/GoogleDriveStorageProvider.ts";
import { OneDriveStorageProvider } from "./providers/OneDriveStorageProvider.ts";
import {
  type ConnectedStorageInput,
  type DeleteStorageObjectInput,
  type DownloadStorageObjectInput,
  type GetStorageObjectUrlInput,
  getProviderSlug,
  type PreparedStorageUpload,
  type PrepareStorageUploadInput,
  StorageCredentialsError,
  type StorageDeletionError,
  type StorageDownloadTarget,
  type StorageDownloadError,
  StorageNeedsReauthorizationError,
  StorageNotConnectedError,
  StorageProvider,
  StorageProviderError,
  type StorageProviderAdapter,
  type StorageUploadError,
} from "./StorageProvider.ts";

type ConnectedStorageToken = {
  readonly accessToken: string;
};

const storageProviderAdapters = {
  [GoogleDriveStorageProvider.storageProvider]: GoogleDriveStorageProvider,
  [OneDriveStorageProvider.storageProvider]: OneDriveStorageProvider,
  [DropboxStorageProvider.storageProvider]: DropboxStorageProvider,
} satisfies Record<PrepareStorageUploadInput["storageProvider"], StorageProviderAdapter>;

const WorkosUserDataProvidersSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      connected_account: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            state: Schema.Literals(["connected", "needs_reauthorization"] as const),
          }),
        ),
      ),
    }),
  ),
});

export const StorageProviderLive = Layer.effect(
  StorageProvider,
  Effect.gen(function* () {
    const { apiKey, clientId } = yield* Effect.all({
      apiKey: Config.redacted("WORKOS_API_KEY"),
      clientId: Config.string("WORKOS_CLIENT_ID"),
    }).pipe(Effect.orDie);
    const workos = new WorkOS({ apiKey: Redacted.value(apiKey), clientId });
    const httpClient = yield* HttpClient.HttpClient;

    const getConnectedToken = Effect.fn("StorageProvider.getConnectedToken")(function* (
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

    const ensureConnected = Effect.fn("StorageProvider.ensureConnected")(function* (
      input: ConnectedStorageInput,
    ) {
      yield* getConnectedToken(input);
    });

    const getLinkedProvider = Effect.fn("StorageProvider.getLinkedProvider")(function* (
      workosUserId: string,
    ) {
      const response = yield* httpClient
        .get(
          `https://api.workos.com/user_management/users/${encodeURIComponent(workosUserId)}/data_providers`,
          {
            headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
          },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new StorageCredentialsError({
                message: "Could not read linked storage.",
                cause,
              }),
          ),
        );
      if (response.status < 200 || response.status >= 300) {
        return yield* new StorageCredentialsError({
          message: "Could not read linked storage.",
          cause: new Error(`WorkOS Pipes returned ${response.status}.`),
        });
      }

      const { data } = yield* HttpClientResponse.schemaBodyJson(WorkosUserDataProvidersSchema)(
        response,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new StorageCredentialsError({
              message: "Could not read linked storage.",
              cause,
            }),
        ),
      );
      const linkedProviders = new Set(
        data.flatMap(({ connected_account: connectedAccount, slug }) => {
          if (connectedAccount === null || connectedAccount === undefined) return [];
          const provider = STORAGE_PROVIDERS.find(
            (candidate) => getProviderSlug(candidate) === slug,
          );
          return provider === undefined ? [] : [provider];
        }),
      );
      if (linkedProviders.size > 1) {
        return yield* new StorageCredentialsError({
          message: "More than one storage provider is linked.",
        });
      }
      return linkedProviders.values().next().value ?? null;
    });

    const prepareUpload = Effect.fn("StorageProvider.prepareUpload")(function* (
      input: Omit<PrepareStorageUploadInput, "accessToken"> & { readonly workosUserId: string },
    ): Effect.fn.Return<PreparedStorageUpload, StorageUploadError> {
      const token = yield* getConnectedToken(input);
      const providerInput = { ...input, accessToken: token.accessToken };
      return yield* storageProviderAdapters[input.storageProvider]
        .prepareUpload(providerInput)
        .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    });

    const getDestinationUrl = Effect.fn("StorageProvider.getDestinationUrl")(function* (
      input: ConnectedStorageInput,
    ): Effect.fn.Return<string, StorageUploadError> {
      const token = yield* getConnectedToken(input);
      const destination = yield* storageProviderAdapters[input.storageProvider]
        .getDestination(token)
        .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      return destination.url;
    });

    const downloadObject = Effect.fn("StorageProvider.downloadObject")(function* (
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

    const getDownloadUrl = Effect.fn("StorageProvider.getDownloadUrl")(function* (
      input: Omit<GetStorageObjectUrlInput, "accessToken"> & { readonly workosUserId: string },
    ): Effect.fn.Return<string, StorageDownloadError> {
      const token = yield* getConnectedToken(input);
      return yield* storageProviderAdapters[input.storageProvider]
        .getDownloadUrl({ ...input, accessToken: token.accessToken })
        .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    });

    const getDownloadTarget = Effect.fn("StorageProvider.getDownloadTarget")(function* (
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

    const deleteObject = Effect.fn("StorageProvider.deleteObject")(function* (
      input: Omit<DeleteStorageObjectInput, "accessToken"> & { readonly workosUserId: string },
    ): Effect.fn.Return<void, StorageDeletionError> {
      const token = yield* getConnectedToken(input);
      return yield* storageProviderAdapters[input.storageProvider]
        .deleteObject({ ...input, accessToken: token.accessToken })
        .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    });

    return StorageProvider.of({
      deleteObject,
      ensureConnected,
      getLinkedProvider,
      prepareUpload,
      getDestinationUrl,
      downloadObject,
      getDownloadUrl,
      getDownloadTarget,
    });
  }),
);
