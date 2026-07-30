import { accountCanSyncWithConnection, type AccountStatus } from "@plakk/shared/PlakkApi";
import type { StorageProvider } from "@plakk/shared";

import type { LocalState } from "../../ipc/contracts.ts";
import { useLocalState } from "./useLocalState.tsx";

const storageSetupUrl = "https://app.plakk.io/storage";

export type StorageStatus =
  | { readonly kind: "loading"; readonly canSync: false }
  | { readonly kind: "offline"; readonly canSync: false }
  | { readonly kind: "failed"; readonly canSync: false }
  | {
      readonly kind: "unlinked";
      readonly canSync: false;
      readonly actionUrl: string;
      readonly account: AccountStatus;
    }
  | {
      readonly kind: "needs-reauthorization";
      readonly canSync: false;
      readonly actionUrl: string;
      readonly account: AccountStatus;
      readonly provider: StorageProvider;
    }
  | {
      readonly kind: "connected";
      readonly canSync: boolean;
      readonly account: AccountStatus;
      readonly destinationUrl: string;
      readonly provider: StorageProvider;
    };

export const storageStatusFromLocalState = (
  localState: LocalState,
  isLoading = false,
  hasError = false,
): StorageStatus => {
  if (isLoading) return { kind: "loading", canSync: false };
  if (hasError) return { kind: "failed", canSync: false };
  if (localState.capability.status === "OFFLINE") {
    return { kind: "offline", canSync: false };
  }

  const account = localState.capability.account;
  if (account.storageProvider === null) {
    return { kind: "unlinked", canSync: false, actionUrl: storageSetupUrl, account };
  }
  const connection = localState.capability.connection;
  if (connection === null || connection.storageProvider !== account.storageProvider) {
    return { kind: "failed", canSync: false };
  }
  if (connection.status === "CONNECTED") {
    return {
      kind: "connected",
      canSync: accountCanSyncWithConnection(account, connection),
      account,
      destinationUrl: connection.externalDestinationUrl,
      provider: account.storageProvider,
    };
  }
  if (connection.status === "NEEDS_REAUTHORIZATION") {
    return {
      kind: "needs-reauthorization",
      canSync: false,
      actionUrl: storageSetupUrl,
      account,
      provider: account.storageProvider,
    };
  }
  return { kind: "unlinked", canSync: false, actionUrl: storageSetupUrl, account };
};

export function useStorageStatus(): StorageStatus {
  const state = useLocalState();
  return storageStatusFromLocalState(state.localState, state.isLoading, state.error !== null);
}

export function useLinkedStorageProvider(): StorageProvider | null {
  const { capability } = useLocalState().localState;
  if (capability.status === "OFFLINE") return capability.storageProvider.value;
  return capability.connection?.status === "NOT_CONNECTED"
    ? null
    : capability.account.storageProvider;
}

export const openStorageSetup = (url: string) => window.ipc.openExternal(url);
