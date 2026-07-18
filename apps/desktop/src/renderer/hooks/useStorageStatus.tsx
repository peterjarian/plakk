import { DropboxIcon } from "@plakk/ui/icons/DropboxIcon";
import { GoogleDriveIcon } from "@plakk/ui/icons/GoogleDriveIcon";
import { OneDriveIcon } from "@plakk/ui/icons/OneDriveIcon";
import { accountCanSyncWithConnection, type AccountStatus } from "@plakk/shared/PlakkApi";
import type { StorageProvider } from "@plakk/shared";
import type { ComponentProps } from "react";

import type { DesktopProjection } from "../../ipc/contracts.ts";
import { useDesktopProjection } from "./useDesktopProjection.tsx";

const storageSetupUrl = "https://app.plakk.io/storage";

export type StorageStatus =
  | { readonly kind: "loading"; readonly canSync: false; readonly provider: StorageProvider | null }
  | { readonly kind: "offline"; readonly canSync: false; readonly provider: StorageProvider | null }
  | { readonly kind: "failed"; readonly canSync: false; readonly provider: StorageProvider | null }
  | { readonly kind: "unlinked"; readonly canSync: false; readonly actionUrl: string }
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

export const storageStatusFromProjection = (
  projection: DesktopProjection,
  isLoading = false,
  hasError = false,
): StorageStatus => {
  const cachedProvider = projection.provider.value;
  if (isLoading) return { kind: "loading", canSync: false, provider: cachedProvider };
  if (hasError) return { kind: "failed", canSync: false, provider: cachedProvider };
  if (projection.capability.status === "OFFLINE") {
    return { kind: "offline", canSync: false, provider: cachedProvider };
  }

  const account = projection.capability.account;
  if (account.storageProvider === null) {
    return { kind: "unlinked", canSync: false, actionUrl: storageSetupUrl };
  }
  const connection = projection.capability.connection;
  if (connection === null || connection.storageProvider !== account.storageProvider) {
    return { kind: "failed", canSync: false, provider: account.storageProvider };
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
  return { kind: "unlinked", canSync: false, actionUrl: storageSetupUrl };
};

export function useStorageStatus(): StorageStatus {
  const state = useDesktopProjection();
  return storageStatusFromProjection(state.projection, state.isLoading, state.error !== null);
}

export const openStorageSetup = (url: string) => window.ipc.openExternal(url);

export const storageProviderLabel = (provider: StorageProvider) => {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return "Google Drive";
    case "ONE_DRIVE":
      return "OneDrive";
    case "DROPBOX":
      return "Dropbox";
  }
};

export function StorageProviderIcon({
  provider,
  ...props
}: { readonly provider: StorageProvider } & ComponentProps<"svg">) {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return <GoogleDriveIcon {...props} />;
    case "ONE_DRIVE":
      return <OneDriveIcon {...props} />;
    case "DROPBOX":
      return <DropboxIcon {...props} />;
  }
}
