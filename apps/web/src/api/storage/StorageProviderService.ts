import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { makeWorkOSClient } from "../auth/makeWorkOSClient.ts";
import { DropboxStorageProvider } from "./DropboxStorageProvider.ts";
import { GoogleDriveStorageProvider } from "./GoogleDriveStorageProvider.ts";
import { OneDriveStorageProvider } from "./OneDriveStorageProvider.ts";
import { getProviderSlug } from "./providerSlug.ts";
import type {
  PreparedStorageUpload,
  PrepareStorageUploadInput,
  StorageProviderAdapter,
  StorageProviderError,
} from "./types.ts";

export class StorageConnectionError extends Schema.TaggedErrorClass<StorageConnectionError>()(
  "StorageConnectionError",
  {
    reason: Schema.Literals(["not_connected", "needs_reauthorization"] as const),
    message: Schema.String,
  },
) {}

export class StorageCredentialsError extends Schema.TaggedErrorClass<StorageCredentialsError>()(
  "StorageCredentialsError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export type StorageUploadError =
  | StorageConnectionError
  | StorageCredentialsError
  | StorageProviderError;

const storageProviderAdapters = {
  GOOGLE_DRIVE: GoogleDriveStorageProvider,
  ONE_DRIVE: OneDriveStorageProvider,
  DROPBOX: DropboxStorageProvider,
} satisfies Record<PrepareStorageUploadInput["storageProvider"], StorageProviderAdapter>;

export class StorageProviderService extends Context.Service<
  StorageProviderService,
  {
    readonly prepareUpload: (
      input: Omit<PrepareStorageUploadInput, "accessToken"> & { readonly workosUserId: string },
    ) => Effect.Effect<PreparedStorageUpload, StorageUploadError>;
  }
>()("@plakk/web/api/storage/StorageProviderService") {
  static readonly Live = Layer.effect(
    StorageProviderService,
    Effect.gen(function* () {
      const { apiKey, clientId } = yield* Effect.all({
        apiKey: Config.redacted("WORKOS_API_KEY"),
        clientId: Config.string("WORKOS_CLIENT_ID"),
      }).pipe(Effect.orDie);
      const workos = yield* makeWorkOSClient(Redacted.value(apiKey), clientId);

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
          return yield* new StorageConnectionError({
            reason: token.error === "needs_reauthorization" ? token.error : "not_connected",
            message: "Connect storage to upload files.",
          });
        }

        const providerInput = { ...input, accessToken: token.accessToken.accessToken };
        return yield* storageProviderAdapters[input.storageProvider].prepareUpload(providerInput);
      });

      return StorageProviderService.of({ prepareUpload });
    }),
  );
}
