import { parseExactHttpOrigin } from "@plakk/shared/ExactHttpOrigin";
import { PlakkApi, type AccountStatus, type ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";

type RpcRequestOptions = {
  readonly headers: Readonly<Record<string, string>>;
};

export type AccountProductSnapshot = {
  readonly account: AccountStatus;
  readonly snippets: ReadonlyArray<ApiSnippet>;
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

export type AccountProductReadError =
  | MissingAccessToken
  | AccessTokenFailure
  | RpcError
  | RpcClientError;

export class AccountProductReader extends Context.Service<
  AccountProductReader,
  {
    readonly read: Effect.Effect<AccountProductSnapshot, AccountProductReadError>;
  }
>()("@plakk/web/product/product-reader/AccountProductReader") {}

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
  const origin = parseExactHttpOrigin(rawOrigin);
  if (origin === null) {
    throw new Error("VITE_PLAKK_API_ORIGIN must be an exact HTTP(S) origin.");
  }
  return `${origin}/api/rpc`;
};

export const makeAccountProductReaderLayer = (options: {
  readonly getAccessToken: () => Promise<string | undefined>;
  readonly rpcUrl: string;
}): Layer.Layer<AccountProductReader> => {
  const protocolLayer = RpcClient.layerProtocolHttp({ url: options.rpcUrl }).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(RpcSerialization.layerNdjson),
  );

  return Layer.succeed(
    AccountProductReader,
    AccountProductReader.of({
      read: Effect.scoped(
        RpcClient.make(PlakkApi).pipe(
          Effect.flatMap((rpc) => readAuthenticatedProduct(rpc, options.getAccessToken)),
          Effect.provide(protocolLayer),
        ),
      ),
    }),
  );
};
