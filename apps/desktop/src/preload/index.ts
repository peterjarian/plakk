import { contextBridge, webUtils } from "electron";
import type { AuthError, AuthStatus } from "../auth.ts";
import type { ClipboardContent } from "../clipboardContent.ts";
import { ipcEvents, ipcMethods } from "../ipc/contracts.ts";
import { invoke, on } from "../ipc/preload.ts";
import type { RendererPreparedFileUploadPayload } from "../storageUpload.ts";
import type { UserConfigPatch } from "../userConfig.ts";

contextBridge.exposeInMainWorld("ipc", {
  auth: {
    getAuth: () => invoke(ipcMethods.authGet, undefined),
    getAccessToken: () => invoke(ipcMethods.authGetAccessToken, undefined),
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
  plakkApiRpcUrl: process.env.PLAKK_API_RPC_URL ?? null,
  storage: {
    uploadPreparedFile: ({ file, ...payload }: RendererPreparedFileUploadPayload) => {
      const filePath = webUtils.getPathForFile(file);
      if (!filePath) return Promise.reject(new Error("Choose a local file to upload."));
      return invoke(ipcMethods.storageUploadPreparedFile, { ...payload, filePath });
    },
  },
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
