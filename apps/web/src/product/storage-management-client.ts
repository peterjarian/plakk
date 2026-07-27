import type { StorageProvider } from "@plakk/shared";
import type {
  StorageCleanupAction,
  StorageCleanupRunResult,
  StorageManagementState,
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

export interface StorageManagementRpcClient {
  readonly BeginStorageCleanup: (
    payload: {
      readonly action: StorageCleanupAction;
      readonly confirmation: "DELETE";
      readonly expectedSnippetCount: number;
      readonly storageProvider: StorageProvider;
    },
    options: RpcRequestOptions,
  ) => Effect.Effect<StorageCleanupRunResult, RpcError | RpcClientError>;
  readonly BeginStorageProviderLink: (
    payload: {
      readonly storageProvider: StorageProvider;
      readonly origin: "WEB";
    },
    options: RpcRequestOptions,
  ) => Effect.Effect<{ readonly url: string }, RpcError | RpcClientError>;
  readonly GetStorageManagementState: (
    payload: undefined,
    options: RpcRequestOptions,
  ) => Effect.Effect<StorageManagementState, RpcError | RpcClientError>;
  readonly RetryStorageCleanup: (
    payload: { readonly storageProvider: StorageProvider },
    options: RpcRequestOptions,
  ) => Effect.Effect<StorageCleanupRunResult, RpcError | RpcClientError>;
}

export type StorageManagementClientError =
  | MissingAccessToken
  | AccessTokenFailure
  | RpcError
  | RpcClientError;

export class StorageManagementClient extends Context.Service<
  StorageManagementClient,
  {
    readonly beginCleanup: (
      action: StorageCleanupAction,
      storageProvider: StorageProvider,
      expectedSnippetCount: number,
    ) => Effect.Effect<StorageCleanupRunResult, StorageManagementClientError>;
    readonly read: Effect.Effect<StorageManagementState, StorageManagementClientError>;
    readonly reauthorize: (
      storageProvider: StorageProvider,
    ) => Effect.Effect<{ readonly url: string }, StorageManagementClientError>;
    readonly retryCleanup: (
      storageProvider: StorageProvider,
    ) => Effect.Effect<StorageCleanupRunResult, StorageManagementClientError>;
  }
>()("@plakk/web/product/storage-management-client/StorageManagementClient") {}

export const readStorageManagement = Effect.fn("StorageManagementClient.read")(function* (
  rpc: StorageManagementRpcClient,
  getAccessToken: () => Promise<string | undefined>,
) {
  const options = yield* authenticatedRpcOptions(getAccessToken);
  return yield* rpc.GetStorageManagementState(undefined, options);
});

export const beginStorageCleanup = Effect.fn("StorageManagementClient.beginCleanup")(function* (
  rpc: StorageManagementRpcClient,
  getAccessToken: () => Promise<string | undefined>,
  action: StorageCleanupAction,
  storageProvider: StorageProvider,
  expectedSnippetCount: number,
) {
  const options = yield* authenticatedRpcOptions(getAccessToken);
  return yield* rpc.BeginStorageCleanup(
    {
      action,
      confirmation: "DELETE",
      expectedSnippetCount,
      storageProvider,
    },
    options,
  );
});

export const retryStorageCleanup = Effect.fn("StorageManagementClient.retryCleanup")(function* (
  rpc: StorageManagementRpcClient,
  getAccessToken: () => Promise<string | undefined>,
  storageProvider: StorageProvider,
) {
  const options = yield* authenticatedRpcOptions(getAccessToken);
  return yield* rpc.RetryStorageCleanup({ storageProvider }, options);
});

export const reauthorizeStorageProvider = Effect.fn("StorageManagementClient.reauthorize")(
  function* (
    rpc: StorageManagementRpcClient,
    getAccessToken: () => Promise<string | undefined>,
    storageProvider: StorageProvider,
  ) {
    const options = yield* authenticatedRpcOptions(getAccessToken);
    return yield* rpc.BeginStorageProviderLink({ origin: "WEB", storageProvider }, options);
  },
);
