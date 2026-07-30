import {
  AccountRpcs,
  BillingRpcs,
  CurrentUser,
  HealthRpcs,
  PlakkApi,
  type AccountStatus,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Effect from "effect/Effect";

import { Billing } from "../billing/Billing.ts";
import { StorageProvider } from "../storage/StorageProvider.ts";
import { SnippetRpcsLive } from "./SnippetRpcsLive.ts";
import { StorageRpcsLive } from "./StorageRpcsLive.ts";

const HealthRpcsLive = HealthRpcs.of({
  Ping: () => Effect.succeed({ ok: true }).pipe(Effect.tap(() => Effect.logInfo("Ping"))),
});

const AccountRpcsLive = AccountRpcs.of({
  GetAccountStatus: Effect.fn("rpc.GetAccountStatus")(function* () {
    const currentUser = yield* CurrentUser;
    const billing = yield* Billing;
    const storage = yield* StorageProvider;
    const billingStatus = yield* billing.status(currentUser).pipe(
      Effect.mapError(
        (error) =>
          new RpcError({
            code: "INTERNAL_SERVER_ERROR",
            message: error.message,
          }),
      ),
    );
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
      canSync: billingStatus.status !== "PAYMENT_REQUIRED",
      storageProvider,
      blockedReasons: billingStatus.status === "PAYMENT_REQUIRED" ? ["billing"] : [],
      billing: billingStatus,
    };
    yield* Effect.logInfo("Returning account status", {
      storageProvider,
      billingStatus: billingStatus.status,
      workosUserId: currentUser.id,
    });
    return accountStatus;
  }),
});

const BillingRpcsLive = BillingRpcs.of({
  OpenBilling: Effect.fn("rpc.OpenBilling")(function* () {
    const currentUser = yield* CurrentUser;
    const billing = yield* Billing;
    const url = yield* billing.open(currentUser).pipe(
      Effect.mapError(
        (error) =>
          new RpcError({
            code:
              error._tag === "BillingIdentityError" || error._tag === "PaymentRequiredError"
                ? "FORBIDDEN"
                : "INTERNAL_SERVER_ERROR",
            message: error.message,
          }),
      ),
    );
    return { url };
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
