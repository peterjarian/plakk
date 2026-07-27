import {
  AccountRpcs,
  CurrentUser,
  HealthRpcs,
  PlakkApi,
  type AccountStatus,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Effect from "effect/Effect";

import { StorageProvider } from "../storage/StorageProvider.ts";
import { SnippetRpcsLive } from "./SnippetRpcsLive.ts";
import { StorageRpcsLive } from "./StorageRpcsLive.ts";

const HealthRpcsLive = HealthRpcs.of({
  Ping: () => Effect.succeed({ ok: true }).pipe(Effect.tap(() => Effect.logInfo("Ping"))),
});

const AccountRpcsLive = AccountRpcs.of({
  GetAccountStatus: Effect.fn("rpc.GetAccountStatus")(function* () {
    const currentUser = yield* CurrentUser;
    const storage = yield* StorageProvider;
    const storageProvider = yield* storage.getLinkedProvider(currentUser.id).pipe(
      Effect.mapError(
        (error) =>
          new RpcError({
            code: "INTERNAL_SERVER_ERROR",
            message: error.message,
          }),
      ),
    );
    const accountStatus: AccountStatus = {
      canSync: true,
      storageProvider,
      blockedReasons: [],
    };
    yield* Effect.logInfo("Returning account status", {
      storageProvider,
      workosUserId: currentUser.id,
    });
    return accountStatus;
  }),
});

export const PlakkApiLive = PlakkApi.toLayer(
  Effect.gen(function* () {
    const snippetRpcs = yield* SnippetRpcsLive;
    return PlakkApi.of({
      ...HealthRpcsLive,
      ...AccountRpcsLive,
      ...StorageRpcsLive,
      ...snippetRpcs,
    });
  }),
);
