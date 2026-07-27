import type { BillingPlan } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import {
  authenticatedRpcOptions,
  type AccessTokenFailure,
  type MissingAccessToken,
  type RpcRequestOptions,
} from "./product-reader.ts";
import { observeBrowserRpc, type BrowserTelemetry } from "./browser-telemetry.ts";

export interface BillingRpcClient {
  readonly BeginBillingCheckout: (
    payload: { readonly plan: BillingPlan },
    options: RpcRequestOptions,
  ) => Effect.Effect<{ readonly url: string }, RpcError | RpcClientError>;
  readonly OpenBillingPortal: (
    payload: undefined,
    options: RpcRequestOptions,
  ) => Effect.Effect<{ readonly url: string }, RpcError | RpcClientError>;
}

export type BillingClientError =
  | MissingAccessToken
  | AccessTokenFailure
  | RpcError
  | RpcClientError;

export class BillingClient extends Context.Service<
  BillingClient,
  {
    readonly beginCheckout: (
      plan: BillingPlan,
    ) => Effect.Effect<{ readonly url: string }, BillingClientError>;
    readonly openPortal: Effect.Effect<{ readonly url: string }, BillingClientError>;
  }
>()("@plakk/web/product/billing-client/BillingClient") {}

export const beginBillingCheckout = Effect.fn("BillingClient.beginCheckout")(function* (
  rpc: BillingRpcClient,
  getAccessToken: () => Promise<string | undefined>,
  plan: BillingPlan,
  telemetry?: BrowserTelemetry,
) {
  const requestOptions = yield* authenticatedRpcOptions(getAccessToken);
  const invoke = (options: RpcRequestOptions) => rpc.BeginBillingCheckout({ plan }, options);
  return yield* observeBrowserRpc(telemetry, "billing.checkout", requestOptions, invoke);
});

export const openBillingPortal = Effect.fn("BillingClient.openPortal")(function* (
  rpc: BillingRpcClient,
  getAccessToken: () => Promise<string | undefined>,
  telemetry?: BrowserTelemetry,
) {
  const requestOptions = yield* authenticatedRpcOptions(getAccessToken);
  const invoke = (options: RpcRequestOptions) => rpc.OpenBillingPortal(undefined, options);
  return yield* observeBrowserRpc(telemetry, "billing.portal", requestOptions, invoke);
});
