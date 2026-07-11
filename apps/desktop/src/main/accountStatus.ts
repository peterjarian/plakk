import { PlakkApi } from "@plakk/shared/PlakkApi";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

const rpcUrl = process.env.PLAKK_RPC_URL ?? "https://app.plakk.io/api/rpc";
const protocolLayer = RpcClient.layerProtocolHttp({ url: rpcUrl }).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(RpcSerialization.layerNdjson),
);

export const getAccountStatus = Effect.fn("DesktopAccountStatus.get")(function* (
  accessToken: string,
) {
  const client = yield* RpcClient.make(PlakkApi).pipe(Effect.provide(protocolLayer));
  return yield* client.GetAccountStatus(undefined, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
});

export const isUnauthenticatedAccountError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "UNAUTHENTICATED";
