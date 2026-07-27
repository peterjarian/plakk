import { STORAGE_PROVIDERS } from "@plakk/shared";
import { WorkOS } from "@workos-inc/node";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { DropboxStorageProvider } from "./providers/DropboxStorageProvider.ts";
import { GoogleDriveStorageProvider } from "./providers/GoogleDriveStorageProvider.ts";
import { OneDriveStorageProvider } from "./providers/OneDriveStorageProvider.ts";
import {
  type BeginStorageAuthorizationInput,
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

const WORKOS_BASE_URL = "https://api.workos.com";

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
const WorkosAuthorizeResponseSchema = Schema.Struct({ url: Schema.String });
const WorkosConnectedAccountSchema = Schema.Struct({
  state: Schema.Literals(["connected", "needs_reauthorization"] as const),
});

const getConnectedAccountUrl = (
  provider: PrepareStorageUploadInput["storageProvider"],
  userId: string,
) =>
  `${WORKOS_BASE_URL}/user_management/users/${encodeURIComponent(userId)}/connected_accounts/${encodeURIComponent(getProviderSlug(provider))}`;

export const StorageProviderLive = Layer.effect(
  StorageProvider,
  Effect.gen(function* () {
    const { apiKey, clientId } = yield* Effect.all({
      apiKey: Config.redacted("WORKOS_API_KEY"),
      clientId: Config.string("WORKOS_CLIENT_ID"),
    }).pipe(Effect.orDie);
    const workos = new WorkOS({ apiKey: Redacted.value(apiKey), clientId });
    const httpClient = yield* HttpClient.HttpClient;

    const beginAuthorization = Effect.fn("StorageProvider.beginAuthorization")(function* (
      input: BeginStorageAuthorizationInput,
    ) {
      const request = yield* HttpClientRequest.post(
        `${WORKOS_BASE_URL}/data-integrations/${encodeURIComponent(getProviderSlug(input.storageProvider))}/authorize`,
      ).pipe(
        HttpClientRequest.bearerToken(Redacted.value(apiKey)),
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.bodyJson({
          return_to: input.returnTo,
          user_id: input.workosUserId,
        }),
        Effect.mapError(
          (cause) =>
            new StorageCredentialsError({
              cause,
              message: "Could not prepare storage authorization.",
            }),
        ),
      );
      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new StorageCredentialsError({
              cause,
              message: "Could not prepare storage authorization.",
            }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new StorageCredentialsError({
          cause: new Error(`WorkOS Pipes returned ${response.status}.`),
          message: "Could not prepare storage authorization.",
        });
      }
      return yield* HttpClientResponse.schemaBodyJson(WorkosAuthorizeResponseSchema)(response).pipe(
        Effect.mapError(
          (cause) =>
            new StorageCredentialsError({
              cause,
              message: "Could not prepare storage authorization.",
            }),
        ),
      );
    });

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

    const getStatus = Effect.fn("StorageProvider.getStatus")(function* (
      input: ConnectedStorageInput,
    ) {
      const response = yield* httpClient
        .get(getConnectedAccountUrl(input.storageProvider, input.workosUserId), {
          headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new StorageCredentialsError({
                cause,
                message: "Could not read storage connection.",
              }),
          ),
        );
      if (response.status === 404) {
        return {
          externalDestinationUrl: null,
          status: "NOT_CONNECTED",
          storageProvider: input.storageProvider,
        } as const;
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new StorageCredentialsError({
          cause: new Error(`WorkOS Pipes returned ${response.status}.`),
          message: "Could not read storage connection.",
        });
      }
      const account = yield* HttpClientResponse.schemaBodyJson(WorkosConnectedAccountSchema)(
        response,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new StorageCredentialsError({
              cause,
              message: "Could not read storage connection.",
            }),
        ),
      );
      if (account.state === "needs_reauthorization") {
        return {
          externalDestinationUrl: null,
          status: "NEEDS_REAUTHORIZATION",
          storageProvider: input.storageProvider,
        } as const;
      }
      return yield* getDestinationUrl(input).pipe(
        Effect.map((externalDestinationUrl) => ({
          externalDestinationUrl,
          status: "CONNECTED" as const,
          storageProvider: input.storageProvider,
        })),
        Effect.catchTags({
          StorageNeedsReauthorizationError: () =>
            Effect.succeed({
              externalDestinationUrl: null,
              status: "NEEDS_REAUTHORIZATION" as const,
              storageProvider: input.storageProvider,
            }),
          StorageNotConnectedError: () =>
            Effect.succeed({
              externalDestinationUrl: null,
              status: "NOT_CONNECTED" as const,
              storageProvider: input.storageProvider,
            }),
        }),
      );
    });

    const disconnect = Effect.fn("StorageProvider.disconnect")(function* (
      input: ConnectedStorageInput,
    ) {
      const response = yield* httpClient
        .del(getConnectedAccountUrl(input.storageProvider, input.workosUserId), {
          headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new StorageCredentialsError({
                cause,
                message: "Could not disconnect storage credentials.",
              }),
          ),
        );
      if (response.status === 404 || (response.status >= 200 && response.status < 300)) return;
      return yield* new StorageCredentialsError({
        cause: new Error(`WorkOS Pipes returned ${response.status}.`),
        message: "Could not disconnect storage credentials.",
      });
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
      beginAuthorization,
      deleteObject,
      disconnect,
      ensureConnected,
      getLinkedProvider,
      getStatus,
      prepareUpload,
      getDestinationUrl,
      downloadObject,
      getDownloadUrl,
      getDownloadTarget,
    });
  }),
);
