import type { StorageProvider } from "@plakk/shared";
import {
  accountCanSyncWithConnection,
  type AccountStatus,
  type ClientCapability,
} from "@plakk/shared/PlakkApi";

export type StorageState =
  | { readonly kind: "offline"; readonly provider: StorageProvider | null }
  | { readonly kind: "unlinked" }
  | { readonly kind: "unavailable"; readonly provider: StorageProvider }
  | { readonly kind: "reauthorize"; readonly provider: StorageProvider }
  | {
      readonly kind: "connected";
      readonly provider: StorageProvider;
      readonly destinationUrl: string;
      readonly canSync: boolean;
      readonly account: AccountStatus;
    };

export function storageState(capability: ClientCapability): StorageState {
  if (capability.status === "OFFLINE") {
    return { kind: "offline", provider: capability.storageProvider.value };
  }
  const provider = capability.account.storageProvider;
  if (provider === null) return { kind: "unlinked" };
  const connection = capability.connection;
  if (connection?.storageProvider !== provider) return { kind: "unavailable", provider };
  if (connection.status === "NEEDS_REAUTHORIZATION") {
    return { kind: "reauthorize", provider };
  }
  if (connection.status === "NOT_CONNECTED") return { kind: "unlinked" };
  if (connection.externalDestinationUrl === null) return { kind: "unavailable", provider };
  return {
    kind: "connected",
    provider,
    destinationUrl: connection.externalDestinationUrl,
    canSync: accountCanSyncWithConnection(capability.account, connection),
    account: capability.account,
  };
}
