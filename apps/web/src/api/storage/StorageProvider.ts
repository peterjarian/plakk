import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { makeWorkOSClient } from "../auth/makeWorkOSClient.ts";
import { DropboxStorageProvider } from "./DropboxStorageProvider.ts";
import { GoogleDriveStorageProvider } from "./GoogleDriveStorageProvider.ts";
import { getProviderSlug } from "./getProviderSlug.ts";
import { OneDriveStorageProvider } from "./OneDriveStorageProvider.ts";
import type {
  PreparedStorageUpload,
  PrepareStorageUploadInput,
  StorageProviderAdapter,
  StorageProviderError,
} from "./types.ts";

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

const storageProviderAdapters = {
  [GoogleDriveStorageProvider.storageProvider]: GoogleDriveStorageProvider,
  [OneDriveStorageProvider.storageProvider]: OneDriveStorageProvider,
  [DropboxStorageProvider.storageProvider]: DropboxStorageProvider,
} satisfies Record<PrepareStorageUploadInput["storageProvider"], StorageProviderAdapter>;

export class StorageProviderService extends Context.Service<
  StorageProviderService,
  {
    readonly prepareUpload: (
      input: Omit<PrepareStorageUploadInput, "accessToken"> & { readonly workosUserId: string },
    ) => Effect.Effect<PreparedStorageUpload, StorageUploadError>;
  }
>()("@plakk/web/api/storage/StorageProvider/StorageProviderService") {
  static readonly Live = Layer.effect(
    StorageProviderService,
    Effect.gen(function* () {
      const { apiKey, clientId } = yield* Effect.all({
        apiKey: Config.redacted("WORKOS_API_KEY"),
        clientId: Config.string("WORKOS_CLIENT_ID"),
      }).pipe(Effect.orDie);
      const workos = yield* makeWorkOSClient(Redacted.value(apiKey), clientId);
      const httpClient = yield* HttpClient.HttpClient;

      const prepareUpload = Effect.fn("StorageProviderService.prepareUpload")(function* (
        input: Omit<PrepareStorageUploadInput, "accessToken"> & { readonly workosUserId: string },
      ): Effect.fn.Return<PreparedStorageUpload, StorageUploadError> {
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

        const providerInput = { ...input, accessToken: token.accessToken.accessToken };
        return yield* storageProviderAdapters[input.storageProvider]
          .prepareUpload(providerInput)
          .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      });

      return StorageProviderService.of({ prepareUpload });
    }),
  );
}
