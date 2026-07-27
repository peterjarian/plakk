import { PlakkApi, type AccountStatus, type ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import type { AccountProductReader, AccountProductSnapshot } from "./account-product-lifetime.ts";

type RpcRequestOptions = {
  readonly headers: Readonly<Record<string, string>>;
};

export interface WebProductRpcClient {
  readonly GetAccountStatus: (
    payload: undefined,
    options: RpcRequestOptions,
  ) => Effect.Effect<AccountStatus, RpcError | RpcClientError>;
  readonly GetSnippetSnapshot: (
    payload: undefined,
    options: RpcRequestOptions,
  ) => Effect.Effect<ReadonlyArray<ApiSnippet>, RpcError | RpcClientError>;
}

export class MissingAccessToken extends Data.TaggedError("MissingAccessToken")<{
  readonly message: string;
}> {}

export class AccessTokenFailure extends Data.TaggedError("AccessTokenFailure")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export const readAuthenticatedProduct = Effect.fn("WebProductReader.read")(function* (
  rpc: WebProductRpcClient,
  getAccessToken: () => Promise<string | undefined>,
): Effect.fn.Return<
  AccountProductSnapshot,
  MissingAccessToken | AccessTokenFailure | RpcError | RpcClientError
> {
  const accessToken = yield* Effect.tryPromise({
    try: getAccessToken,
    catch: (cause) =>
      new AccessTokenFailure({
        cause,
        message: "AuthKit could not refresh the access token.",
      }),
  });
  if (accessToken === undefined || accessToken === "") {
    return yield* new MissingAccessToken({
      message: "AuthKit did not provide an authenticated access token.",
    });
  }

  const options = {
    headers: { authorization: `Bearer ${accessToken}` },
  } as const;
  const [account, snippets] = yield* Effect.all(
    [rpc.GetAccountStatus(undefined, options), rpc.GetSnippetSnapshot(undefined, options)],
    { concurrency: "unbounded" },
  );
  return { account, snippets };
});

export const resolveProductRpcUrl = (configuredOrigin: string | undefined): string => {
  const rawOrigin = configuredOrigin ?? "http://localhost:3100";
  const url = new URL(rawOrigin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("VITE_PLAKK_API_ORIGIN must be an exact HTTP(S) origin.");
  }
  return `${url.origin}/api/rpc`;
};

export const makeWebProductReader = (options: {
  readonly getAccessToken: () => Promise<string | undefined>;
  readonly rpcUrl: string;
}): AccountProductReader => {
  const protocolLayer = RpcClient.layerProtocolHttp({ url: options.rpcUrl }).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(RpcSerialization.layerNdjson),
  );

  return {
    read: (_accountId, signal) =>
      Effect.runPromise(
        Effect.scoped(
          RpcClient.make(PlakkApi).pipe(
            Effect.flatMap((rpc) => readAuthenticatedProduct(rpc, options.getAccessToken)),
            Effect.provide(protocolLayer),
          ),
        ),
        { signal },
      ),
  };
};
