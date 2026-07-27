import type { StorageProvider as StorageProviderName } from "@plakk/shared";
import { CurrentUser, StorageRpcs, type StorageOnboardingOrigin } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import {
  storageOnboardingReturnSearch,
  storageOnboardingRouteSearchParams,
} from "@plakk/shared/StorageOnboardingReturn";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import { StorageLifecycle } from "../storage/StorageLifecycle.ts";
import { StorageProvider } from "../storage/StorageProvider.ts";
import { configuredWebOrigin as validateConfiguredWebOrigin } from "../WebOrigin.ts";

export const storageProviderReturnUrl = (
  configuredWebOrigin: string,
  storageProvider: StorageProviderName,
  origin: StorageOnboardingOrigin,
  requireHttps = false,
): string => {
  const webOrigin = validateConfiguredWebOrigin(configuredWebOrigin, requireHttps);
  const returnUrl = new URL("/storage", webOrigin);
  returnUrl.search = storageOnboardingRouteSearchParams(
    storageOnboardingReturnSearch(storageProvider, origin),
  ).toString();
  return returnUrl.href;
};

const storageStatusError = (message: string) =>
  new RpcError({ code: "INTERNAL_SERVER_ERROR", message });

export const StorageRpcsLive = StorageRpcs.of({
  BeginStorageProviderLink: Effect.fn("rpc.BeginStorageProviderLink")(function* (input) {
    const { configuredWebOrigin, nodeEnv } = yield* Effect.all({
      configuredWebOrigin: Config.string("PLAKK_WEB_ORIGIN"),
      nodeEnv: Config.string("NODE_ENV").pipe(Config.withDefault("development")),
    }).pipe(Effect.orDie);
    const currentUser = yield* CurrentUser;
    const lifecycle = yield* StorageLifecycle;
    const returnTo = yield* Effect.sync(() =>
      storageProviderReturnUrl(
        configuredWebOrigin,
        input.storageProvider,
        input.origin,
        nodeEnv === "production",
      ),
    ).pipe(Effect.orDie);
    return yield* lifecycle
      .beginAuthorization(currentUser.id, input.storageProvider, returnTo)
      .pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
  }),
  GetStorageProviderStatus: Effect.fn("rpc.GetStorageProviderStatus")(function* (input) {
    const currentUser = yield* CurrentUser;
    const storage = yield* StorageProvider;
    return yield* storage
      .getStatus({
        storageProvider: input.storageProvider,
        workosUserId: currentUser.id,
      })
      .pipe(
        Effect.mapError((error) => storageStatusError(error.message)),
        Effect.annotateSpans({ storageProvider: input.storageProvider }),
      );
  }),
  GetStorageManagementState: Effect.fn("rpc.GetStorageManagementState")(function* () {
    const currentUser = yield* CurrentUser;
    const lifecycle = yield* StorageLifecycle;
    return yield* lifecycle.getManagementState(currentUser.id);
  }),
  BeginStorageCleanup: Effect.fn("rpc.BeginStorageCleanup")(function* (input) {
    const currentUser = yield* CurrentUser;
    const lifecycle = yield* StorageLifecycle;
    return yield* lifecycle
      .beginCleanup({
        action: input.action,
        expectedSnippetCount: input.expectedSnippetCount,
        storageProvider: input.storageProvider,
        workosUserId: currentUser.id,
      })
      .pipe(
        Effect.annotateSpans({
          action: input.action,
          storageProvider: input.storageProvider,
        }),
      );
  }),
  RetryStorageCleanup: Effect.fn("rpc.RetryStorageCleanup")(function* (input) {
    const currentUser = yield* CurrentUser;
    const lifecycle = yield* StorageLifecycle;
    return yield* lifecycle
      .retryCleanup(currentUser.id, input.storageProvider)
      .pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
  }),
});
