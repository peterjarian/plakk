import { RpcError } from "@plakk/shared/RpcError";
import { Effect } from "effect";

import type { StorageDownloadError } from "./StorageProvider.ts";

export const mapStorageErrorsToRpc = <A, R>(
  effect: Effect.Effect<A, StorageDownloadError, R>,
): Effect.Effect<A, RpcError, R> =>
  effect.pipe(
    Effect.catchTags({
      StorageObjectNotFoundError: (error) =>
        Effect.fail(new RpcError({ code: "NOT_FOUND", message: error.message })),
      StorageNotConnectedError: (error) =>
        Effect.fail(new RpcError({ code: "FORBIDDEN", message: error.message })),
      StorageNeedsReauthorizationError: (error) =>
        Effect.fail(new RpcError({ code: "FORBIDDEN", message: error.message })),
      StorageCredentialsError: (error) =>
        Effect.fail(new RpcError({ code: "INTERNAL_SERVER_ERROR", message: error.message })),
      StorageProviderError: (error) =>
        Effect.fail(
          new RpcError({
            code: "INTERNAL_SERVER_ERROR",
            message: `${error.storageProvider}: ${error.message}`,
          }),
        ),
    }),
  );
