import { contextBridge, webUtils } from "electron";
import type {
  AuthError,
  AuthStatus,
  ClipboardContent,
  TrayDroppedItem,
  TrayAccountState,
  UserConfig,
  UserConfigPatch,
} from "../ipc/contracts.ts";
import { ipcEvents, ipcMethods } from "../ipc/contracts.ts";
import { invoke, on } from "../ipc/preload.ts";
import type { RendererPreparedFileUploadPayload, StorageUploadResult } from "../storageUpload.ts";

const plakkRpcUrl = process.env.PLAKK_RPC_URL ?? "https://app.plakk.io/api/rpc";

export type DesktopApi = {
  readonly auth: {
    readonly getAuth: () => Promise<AuthStatus>;
    readonly onError: (callback: (error: AuthError) => void) => () => void;
    readonly onStatusChanged: (callback: (status: AuthStatus) => void) => () => void;
    readonly signIn: () => Promise<void>;
    readonly signOut: () => Promise<void>;
  };
  readonly clipboard: {
    readonly onPaste: (callback: (content: ClipboardContent) => void) => () => void;
  };
  readonly openExternal: (url: string) => Promise<void>;
  readonly navigation: {
    readonly onRequested: (callback: (view: "home" | "settings") => void) => () => void;
  };
  readonly storage: {
    readonly cancelUpload: (id: string) => Promise<void>;
    readonly uploadPreparedFile: (
      payload: RendererPreparedFileUploadPayload,
    ) => Promise<StorageUploadResult>;
    readonly onProgress: (
      callback: (progress: { id: string; progress: number }) => void,
    ) => () => void;
  };
  readonly snippets: {
    readonly copy: (id: string) => Promise<void>;
    readonly forget: (id: string) => Promise<void>;
    readonly getThumbnail: (id: string) => Promise<{ url: string }>;
  };
  readonly tray: {
    readonly getAccountState: () => Promise<TrayAccountState>;
    readonly onAccountStateChanged: (callback: (state: TrayAccountState) => void) => () => void;
    readonly onDroppedItem: (callback: (item: TrayDroppedItem) => void) => () => void;
  };
  readonly userConfig: {
    readonly get: () => Promise<UserConfig>;
    readonly reset: () => Promise<UserConfig>;
    readonly set: (patch: UserConfigPatch) => Promise<UserConfig>;
  };
  readonly runtimeConfig: {
    readonly plakkRpcUrl: string;
  };
  readonly versions: {
    readonly chrome: string;
    readonly electron: string;
    readonly node: string;
  };
};

const desktopApi = {
  auth: {
    getAuth: () => invoke(ipcMethods.authGet, undefined),
    onError: (callback: (error: AuthError) => void) => on(ipcEvents.authError, callback),
    onStatusChanged: (callback: (status: AuthStatus) => void) =>
      on(ipcEvents.authStatusChanged, callback),
    signIn: () => invoke(ipcMethods.authSignIn, undefined),
    signOut: () => invoke(ipcMethods.authSignOut, undefined),
  },
  clipboard: {
    onPaste: (callback: (content: ClipboardContent) => void) =>
      on(ipcEvents.clipboardPaste, callback),
  },
  openExternal: (url: string) => invoke(ipcMethods.openExternal, url),
  navigation: {
    onRequested: (callback: (view: "home" | "settings") => void) =>
      on(ipcEvents.navigate, callback),
  },
  storage: {
    cancelUpload: (id: string) => invoke(ipcMethods.storageCancelUpload, id),
    uploadPreparedFile: ({ file, ...payload }: RendererPreparedFileUploadPayload) => {
      if (payload.bytes !== undefined) {
        return invoke(ipcMethods.storageUploadPreparedFile, payload);
      }
      const filePath =
        payload.filePath ?? (file === undefined ? "" : webUtils.getPathForFile(file));
      if (!filePath) return Promise.reject(new Error("Choose a local file to upload."));
      return invoke(ipcMethods.storageUploadPreparedFile, { ...payload, filePath });
    },
    onProgress: (callback: (progress: { id: string; progress: number }) => void) =>
      on(ipcEvents.storageUploadProgress, callback),
  },
  snippets: {
    copy: (id: string) => invoke(ipcMethods.snippetCopy, id),
    forget: (id: string) => invoke(ipcMethods.snippetForget, id),
    getThumbnail: (id: string) => invoke(ipcMethods.snippetGetThumbnail, id),
  },
  tray: {
    getAccountState: () => invoke(ipcMethods.trayGetAccountState, undefined),
    onAccountStateChanged: (callback: (state: TrayAccountState) => void) =>
      on(ipcEvents.trayAccountStateChanged, callback),
    onDroppedItem: (callback: (item: TrayDroppedItem) => void) =>
      on(ipcEvents.trayDroppedItem, callback),
  },
  userConfig: {
    get: () => invoke(ipcMethods.userConfigGet, undefined),
    reset: () => invoke(ipcMethods.userConfigReset, undefined),
    set: (patch: UserConfigPatch) => invoke(ipcMethods.userConfigSet, patch),
  },
  runtimeConfig: {
    plakkRpcUrl,
  },
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
} satisfies DesktopApi;

contextBridge.exposeInMainWorld("ipc", desktopApi);
