import { contextBridge } from "electron";
import type {
  AuthError,
  AuthStatus,
  ClipboardContent,
  UserConfig,
  UserConfigPatch,
} from "../ipc/contracts.ts";
import { ipcEvents, ipcMethods } from "../ipc/contracts.ts";
import { invoke, on } from "../ipc/preload.ts";

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
  readonly userConfig: {
    readonly get: () => Promise<UserConfig>;
    readonly reset: () => Promise<UserConfig>;
    readonly set: (patch: UserConfigPatch) => Promise<UserConfig>;
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
  userConfig: {
    get: () => invoke(ipcMethods.userConfigGet, undefined),
    reset: () => invoke(ipcMethods.userConfigReset, undefined),
    set: (patch: UserConfigPatch) => invoke(ipcMethods.userConfigSet, patch),
  },
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
} satisfies DesktopApi;

contextBridge.exposeInMainWorld("ipc", desktopApi);
