import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { accountCanSync, type AccountStatus, type PipeConnection } from "@plakk/shared/PlakkApi";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";
import { DropboxIcon } from "@plakk/ui/icons/DropboxIcon";
import { GoogleDriveIcon } from "@plakk/ui/icons/GoogleDriveIcon";
import { OneDriveIcon } from "@plakk/ui/icons/OneDriveIcon";
import type { StorageProvider } from "@plakk/shared";
import { createPlakkRpc } from "@plakk/ui/atoms/rpc";
import { useAuth } from "./useAuth.ts";

const storageSetupUrl = "https://app.plakk.io/storage";
const emptyAccountStatusAtom = Atom.make(AsyncResult.initial<AccountStatus>());
const emptyPipeConnectionAtom = Atom.make(AsyncResult.initial<PipeConnection>());
let sharedPlakkRpc: ReturnType<typeof createPlakkRpc> | undefined;

const getPlakkRpc = () => (sharedPlakkRpc ??= createPlakkRpc(window.ipc.runtimeConfig.plakkRpcUrl));

export const storageStatusReactivityKeys = ["storage-status"] as const;

export type StorageStatus =
  | { readonly kind: "loading"; readonly canSync: false; readonly provider: StorageProvider | null }
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

export const storageStatusFrom = (
  accountResult: AsyncResult.AsyncResult<AccountStatus, unknown>,
  connectionResult: AsyncResult.AsyncResult<PipeConnection, unknown>,
): StorageStatus => {
  if (AsyncResult.isFailure(accountResult))
    return { kind: "failed", canSync: false, provider: null };
  if (!AsyncResult.isSuccess(accountResult))
    return { kind: "loading", canSync: false, provider: null };

  const account = accountResult.value;
  if (account.storageProvider === null)
    return { kind: "unlinked", canSync: false, actionUrl: storageSetupUrl };

  if (AsyncResult.isFailure(connectionResult)) {
    return { kind: "failed", canSync: false, provider: account.storageProvider };
  }
  if (!AsyncResult.isSuccess(connectionResult)) {
    return { kind: "loading", canSync: false, provider: account.storageProvider };
  }

  const connection = connectionResult.value;
  if (connection.status === "CONNECTED") {
    return {
      kind: "connected",
      canSync: accountCanSync(account),
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

export const createStorageSetupRefresh = () => {
  let pending = false;
  return {
    begin: () => {
      pending = true;
    },
    cancel: () => {
      pending = false;
    },
    focus: (refresh: () => void) => {
      if (!pending) return;
      pending = false;
      refresh();
    },
  };
};

type StorageStatusContextValue = {
  readonly openSetup: (url: string) => void;
  readonly status: StorageStatus;
};

const StorageStatusContext = createContext<StorageStatusContextValue | null>(null);

export function StorageStatusProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const plakkRpc = useMemo(getPlakkRpc, []);
  const headers = useMemo(
    () => (auth.accessToken === null ? null : { authorization: `Bearer ${auth.accessToken}` }),
    [auth.accessToken],
  );
  const accountAtom = useMemo(
    () =>
      headers === null
        ? emptyAccountStatusAtom
        : plakkRpc.query("GetAccountStatus", undefined, {
            headers,
            reactivityKeys: storageStatusReactivityKeys,
            serializationKey: "account-status",
          }),
    [headers],
  );
  const accountResult = useAtomValue(accountAtom);
  const account = AsyncResult.getOrElse(accountResult, () => null);
  const connectionAtom = useMemo(
    () =>
      headers === null || account?.storageProvider === null || account === null
        ? emptyPipeConnectionAtom
        : plakkRpc.query(
            "GetPipeConnectionStatus",
            { storageProvider: account.storageProvider },
            {
              headers,
              reactivityKeys: storageStatusReactivityKeys,
              serializationKey: `pipe-connection-${account.storageProvider}`,
            },
          ),
    [account, headers],
  );
  const connectionResult = useAtomValue(connectionAtom);
  const refreshAccount = useAtomRefresh(accountAtom);
  const refreshConnection = useAtomRefresh(connectionAtom);
  const refresh = useCallback(() => {
    refreshAccount();
    refreshConnection();
  }, [refreshAccount, refreshConnection]);
  const setupRefresh = useMemo(createStorageSetupRefresh, []);
  const openSetup = useCallback(
    (url: string) => {
      setupRefresh.begin();
      void window.ipc.openExternal(url).catch(setupRefresh.cancel);
    },
    [setupRefresh],
  );

  useEffect(() => {
    const onFocus = () => setupRefresh.focus(refresh);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, setupRefresh]);

  const value = useMemo(
    () => ({ openSetup, status: storageStatusFrom(accountResult, connectionResult) }),
    [accountResult, connectionResult, openSetup],
  );
  return <StorageStatusContext value={value}>{children}</StorageStatusContext>;
}

const useStorageStatusContext = () => {
  const value = useContext(StorageStatusContext);
  if (value === null) throw new Error("Storage status must be used inside StorageStatusProvider.");
  return value;
};

export function useStorageStatus(): StorageStatus {
  return useStorageStatusContext().status;
}

export function useStorageSetup(): (url: string) => void {
  return useStorageStatusContext().openSetup;
}

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
