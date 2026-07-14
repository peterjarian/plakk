import { PlakkApi } from "@plakk/shared/PlakkApi";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

const configuredRpcUrl = process.env.PLAKK_RPC_URL ?? "https://app.plakk.io/api/rpc";
const rpcUrl = configuredRpcUrl.startsWith("/")
  ? new URL(configuredRpcUrl, "http://localhost:3000").toString()
  : configuredRpcUrl;
const protocolLayer = RpcClient.layerProtocolHttp({ url: rpcUrl }).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(RpcSerialization.layerNdjson),
);

export const makePlakkClient = RpcClient.make(PlakkApi).pipe(Effect.provide(protocolLayer));

export const getAccountStatus = Effect.fn("DesktopAccountStatus.get")(function* (
  accessToken: string,
) {
  const client = yield* makePlakkClient;
  return yield* client.GetAccountStatus(undefined, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
});

export const getSnippetCopyPayload = Effect.fn("DesktopSnippetCopyPayload.get")(function* (
  accessToken: string,
  id: string,
) {
  const client = yield* makePlakkClient;
  return yield* client.GetSnippetCopyPayload(
    { id },
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
});

export const isUnauthenticatedAccountError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "UNAUTHENTICATED";
