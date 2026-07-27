import type { StorageProvider } from "@plakk/shared";
import {
  type AccountStatus,
  type StorageOnboardingOrigin,
  type StorageProviderStatus,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import {
  type AccessTokenFailure,
  authenticatedRpcOptions,
  type MissingAccessToken,
  type RpcRequestOptions,
} from "./product-reader.ts";
import { observeBrowserRpc, type BrowserTelemetry } from "./browser-telemetry.ts";

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
    payload: {
      readonly consumeAuthorization: boolean;
      readonly storageProvider: StorageProvider;
    },
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
      consumeAuthorization: boolean,
    ) => Effect.Effect<StorageOnboardingRead, StorageOnboardingClientError>;
  }
>()("@plakk/web/product/storage-onboarding-client/StorageOnboardingClient") {}

export const readStorageOnboarding = Effect.fn("StorageOnboardingClient.read")(function* (
  rpc: StorageOnboardingRpcClient,
  getAccessToken: () => Promise<string | undefined>,
  providerHint: StorageProvider | null,
  consumeAuthorization: boolean,
  telemetry?: BrowserTelemetry,
): Effect.fn.Return<StorageOnboardingRead, StorageOnboardingClientError> {
  const options = yield* authenticatedRpcOptions(getAccessToken);
  const invoke = Effect.fn("StorageOnboardingClient.readObserved")(function* (
    requestOptions: RpcRequestOptions,
  ) {
    const initialAccount = yield* rpc.GetAccountStatus(undefined, requestOptions);
    const provider = initialAccount.storageProvider ?? providerHint;
    if (provider === null) return { account: initialAccount, providerStatus: null };

    const providerStatus = yield* rpc.GetStorageProviderStatus(
      { consumeAuthorization, storageProvider: provider },
      requestOptions,
    );
    const account =
      providerStatus.status === "CONNECTED"
        ? yield* rpc.GetAccountStatus(undefined, requestOptions)
        : initialAccount;
    return { account, providerStatus };
  });
  return yield* observeBrowserRpc(telemetry, "storage.status", options, invoke);
});

export const beginStorageProviderLink = Effect.fn("StorageOnboardingClient.begin")(function* (
  rpc: StorageOnboardingRpcClient,
  getAccessToken: () => Promise<string | undefined>,
  storageProvider: StorageProvider,
  origin: StorageOnboardingOrigin,
  telemetry?: BrowserTelemetry,
): Effect.fn.Return<{ readonly url: string }, StorageOnboardingClientError> {
  const options = yield* authenticatedRpcOptions(getAccessToken);
  const invoke = (requestOptions: RpcRequestOptions) =>
    rpc.BeginStorageProviderLink({ storageProvider, origin }, requestOptions);
  return yield* observeBrowserRpc(telemetry, "storage.begin-link", options, invoke);
});
