import {
  AccountRpcs,
  BillingRpcs,
  CurrentUser,
  HealthRpcs,
  PlakkApi,
  type AccountStatus,
} from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";

import { AccountCapability } from "../account/AccountCapability.ts";
import { AccountBilling } from "../billing/AccountBilling.ts";
import { RpcError } from "@plakk/shared/RpcError";
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

const BillingRpcsLive = BillingRpcs.of({
  BeginBillingCheckout: Effect.fn("rpc.BeginBillingCheckout")(function* ({ plan }) {
    const currentUser = yield* CurrentUser;
    const billing = yield* AccountBilling;
    return yield* billing.beginCheckout(currentUser.id, plan).pipe(
      Effect.mapError(
        (error) =>
          new RpcError({
            code: "INTERNAL_SERVER_ERROR",
            message: error.message,
          }),
      ),
    );
  }),
  OpenBillingPortal: Effect.fn("rpc.OpenBillingPortal")(function* () {
    const currentUser = yield* CurrentUser;
    const billing = yield* AccountBilling;
    return yield* billing.openPortal(currentUser.id).pipe(
      Effect.mapError(
        (error) =>
          new RpcError({
            code: "INTERNAL_SERVER_ERROR",
            message: error.message,
          }),
      ),
    );
  }),
});

export const PlakkApiLive = PlakkApi.toLayer(
  Effect.gen(function* () {
    const snippetRpcs = yield* SnippetRpcsLive;
    return PlakkApi.of({
      ...HealthRpcsLive,
      ...AccountRpcsLive,
      ...BillingRpcsLive,
      ...StorageRpcsLive,
      ...snippetRpcs,
    });
  }),
);
