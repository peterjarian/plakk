import {
  AccountRpcs,
  CurrentUser,
  HealthRpcs,
  PlakkApi,
  type AccountStatus,
} from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";

import { AccountCapability } from "../account/AccountCapability.ts";
import { SnippetRpcsLive } from "./SnippetRpcsLive.ts";
import { StorageRpcsLive } from "./StorageRpcsLive.ts";

const HealthRpcsLive = HealthRpcs.of({
  Ping: () => Effect.succeed({ ok: true }).pipe(Effect.tap(() => Effect.logInfo("Ping"))),
});

const AccountRpcsLive = AccountRpcs.of({
  GetAccountStatus: Effect.fn("rpc.GetAccountStatus")(function* () {
    const currentUser = yield* CurrentUser;
    const capability = yield* AccountCapability;
    const accountStatus: AccountStatus = yield* capability.getStatus(currentUser.id);
    yield* Effect.logInfo("Returning account status", {
      blockedReasons: accountStatus.blockedReasons,
      entitlementStatus: accountStatus.accessEntitlement.status,
      storageProvider: accountStatus.storageProvider,
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
