import { parseExactHttpOrigin } from "@plakk/shared/ExactHttpOrigin";
import {
  SNIPPETS_CHANGED,
  type AccountStatus,
  type ApiSnippet,
  type SnippetInvalidationEvent,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";

export type RpcRequestOptions = {
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
  readonly WatchSnippetInvalidations: (
    payload: undefined,
    options: RpcRequestOptions,
  ) => Stream.Stream<SnippetInvalidationEvent, RpcError | RpcClientError>;
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
    readonly invalidations: Stream.Stream<void, AccountProductReadError>;
    readonly read: Effect.Effect<AccountProductSnapshot, AccountProductReadError>;
  }
>()("@plakk/web/product/product-reader/AccountProductReader") {}

export const authenticatedRpcOptions = Effect.fn("WebProductReader.authorize")(function* (
  getAccessToken: () => Promise<string | undefined>,
) {
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

  return {
    headers: { authorization: `Bearer ${accessToken}` },
  } as const;
});

export const readAuthenticatedProduct = Effect.fn("WebProductReader.read")(function* (
  rpc: WebProductRpcClient,
  getAccessToken: () => Promise<string | undefined>,
): Effect.fn.Return<AccountProductSnapshot, AccountProductReadError> {
  const options = yield* authenticatedRpcOptions(getAccessToken);
  const [account, snippets] = yield* Effect.all(
    [rpc.GetAccountStatus(undefined, options), rpc.GetSnippetSnapshot(undefined, options)],
    { concurrency: "unbounded" },
  );
  return { account, snippets };
});

export const watchAuthenticatedInvalidations = (
  rpc: WebProductRpcClient,
  getAccessToken: () => Promise<string | undefined>,
): Stream.Stream<void, AccountProductReadError> =>
  Stream.unwrap(
    authenticatedRpcOptions(getAccessToken).pipe(
      Effect.map((options) => rpc.WatchSnippetInvalidations(undefined, options)),
    ),
  ).pipe(
    Stream.filter((event) => event === SNIPPETS_CHANGED),
    Stream.map(() => undefined),
  );

export const resolveProductRpcUrl = (
  configuredOrigin: string | undefined,
  allowDevelopmentFallback = false,
): string => {
  const rawOrigin =
    configuredOrigin ?? (allowDevelopmentFallback ? "http://localhost:3100" : undefined);
  if (rawOrigin === undefined) {
    throw new Error("VITE_PLAKK_API_ORIGIN is required outside local development.");
  }
  const origin = parseExactHttpOrigin(rawOrigin);
  if (origin === null) {
    throw new Error("VITE_PLAKK_API_ORIGIN must be an exact HTTP(S) origin.");
  }
  if (!allowDevelopmentFallback && !origin.startsWith("https://")) {
    throw new Error("VITE_PLAKK_API_ORIGIN must use HTTPS outside local development.");
  }
  return `${origin}/api/rpc`;
};
