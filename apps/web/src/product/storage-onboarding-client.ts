import type { StorageProvider } from "@plakk/shared";
import {
  PlakkApi,
  type AccountStatus,
  type StorageOnboardingOrigin,
  type StorageProviderStatus,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import {
  type AccessTokenFailure,
  authenticatedRpcOptions,
  type MissingAccessToken,
} from "./product-reader.ts";

type RpcRequestOptions = {
  readonly headers: Readonly<Record<string, string>>;
};

export type StorageOnboardingRead = {
  readonly account: AccountStatus;
  readonly providerStatus: StorageProviderStatus | null;
};

export interface StorageOnboardingRpcClient {
  readonly BeginStorageProviderLink: (
    payload: {
      readonly storageProvider: StorageProvider;
      readonly origin: StorageOnboardingOrigin;
    },
    options: RpcRequestOptions,
  ) => Effect.Effect<{ readonly url: string }, RpcError | RpcClientError>;
  readonly GetAccountStatus: (
    payload: undefined,
    options: RpcRequestOptions,
  ) => Effect.Effect<AccountStatus, RpcError | RpcClientError>;
  readonly GetStorageProviderStatus: (
    payload: { readonly storageProvider: StorageProvider },
    options: RpcRequestOptions,
  ) => Effect.Effect<StorageProviderStatus, RpcError | RpcClientError>;
}

export type StorageOnboardingClientError =
  | MissingAccessToken
  | AccessTokenFailure
  | RpcError
  | RpcClientError;

export class StorageOnboardingClient extends Context.Service<
  StorageOnboardingClient,
  {
    readonly begin: (
      storageProvider: StorageProvider,
      origin: StorageOnboardingOrigin,
    ) => Effect.Effect<{ readonly url: string }, StorageOnboardingClientError>;
    readonly read: (
      providerHint: StorageProvider | null,
    ) => Effect.Effect<StorageOnboardingRead, StorageOnboardingClientError>;
  }
>()("@plakk/web/product/storage-onboarding-client/StorageOnboardingClient") {}

export const readStorageOnboarding = Effect.fn("StorageOnboardingClient.read")(function* (
  rpc: StorageOnboardingRpcClient,
  getAccessToken: () => Promise<string | undefined>,
  providerHint: StorageProvider | null,
): Effect.fn.Return<StorageOnboardingRead, StorageOnboardingClientError> {
  const options = yield* authenticatedRpcOptions(getAccessToken);
  const initialAccount = yield* rpc.GetAccountStatus(undefined, options);
  const provider = initialAccount.storageProvider ?? providerHint;
  if (provider === null) return { account: initialAccount, providerStatus: null };

  const providerStatus = yield* rpc.GetStorageProviderStatus(
    { storageProvider: provider },
    options,
  );
  const account =
    providerStatus.status === "CONNECTED"
      ? yield* rpc.GetAccountStatus(undefined, options)
      : initialAccount;
  return { account, providerStatus };
});

export const beginStorageProviderLink = Effect.fn("StorageOnboardingClient.begin")(function* (
  rpc: StorageOnboardingRpcClient,
  getAccessToken: () => Promise<string | undefined>,
  storageProvider: StorageProvider,
  origin: StorageOnboardingOrigin,
): Effect.fn.Return<{ readonly url: string }, StorageOnboardingClientError> {
  const options = yield* authenticatedRpcOptions(getAccessToken);
  return yield* rpc.BeginStorageProviderLink({ storageProvider, origin }, options);
});

export const makeStorageOnboardingClientLayer = (options: {
  readonly getAccessToken: () => Promise<string | undefined>;
  readonly rpcUrl: string;
}): Layer.Layer<StorageOnboardingClient> => {
  const protocolLayer = RpcClient.layerProtocolHttp({ url: options.rpcUrl }).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(RpcSerialization.layerNdjson),
  );

  return Layer.effect(
    StorageOnboardingClient,
    RpcClient.make(PlakkApi).pipe(
      Effect.map((rpc) =>
        StorageOnboardingClient.of({
          begin: (storageProvider, origin) =>
            beginStorageProviderLink(rpc, options.getAccessToken, storageProvider, origin),
          read: (providerHint) => readStorageOnboarding(rpc, options.getAccessToken, providerHint),
        }),
      ),
      Effect.provide(protocolLayer),
    ),
  );
};
