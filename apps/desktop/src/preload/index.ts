import { contextBridge } from "electron";
import type { AuthError, AuthStatus } from "../auth.js";
import type { ClipboardContent } from "../clipboardContent.js";
import { ipcEvents, ipcMethods } from "../ipc/contracts.js";
import { invoke, on } from "../ipc/preload.js";
import type { UserConfigPatch } from "../userConfig.js";

contextBridge.exposeInMainWorld("ipc", {
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
});
