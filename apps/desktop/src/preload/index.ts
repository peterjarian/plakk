import { contextBridge, webUtils } from "electron";
import type {
  CreateStoredSnippetPayload,
  CreateTextSnippetPayload,
  DeleteSnippetPayload,
  GetPipeConnectionStatusPayload,
  ListSnippetsPayload,
  PrepareStoredSnippetUploadPayload,
  UpdateStoredSnippetUploadStatusPayload,
} from "@plakk/shared/PlakkApi";
import type { AuthError, AuthStatus } from "../auth.ts";
import type { ClipboardContent } from "../clipboardContent.ts";
import { ipcEvents, ipcMethods } from "../ipc/contracts.ts";
import { invoke, on } from "../ipc/preload.ts";
import type { RendererStoredSnippetFileUploadPayload } from "../storageUpload.ts";
import type { UserConfigPatch } from "../userConfig.ts";

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
  plakkApi: {
    createStoredSnippet: (payload: CreateStoredSnippetPayload) =>
      invoke(ipcMethods.plakkApiCreateStoredSnippet, payload),
    createTextSnippet: (payload: CreateTextSnippetPayload) =>
      invoke(ipcMethods.plakkApiCreateTextSnippet, payload),
    deleteSnippet: (payload: DeleteSnippetPayload) =>
      invoke(ipcMethods.plakkApiDeleteSnippet, payload),
    getAccountStatus: () => invoke(ipcMethods.plakkApiGetAccountStatus, undefined),
    getPipeConnectionStatus: (payload: GetPipeConnectionStatusPayload) =>
      invoke(ipcMethods.plakkApiGetPipeConnectionStatus, payload),
    listSnippets: (payload: ListSnippetsPayload) =>
      invoke(ipcMethods.plakkApiListSnippets, payload),
    prepareStoredSnippetUpload: (payload: PrepareStoredSnippetUploadPayload) =>
      invoke(ipcMethods.plakkApiPrepareStoredSnippetUpload, payload),
    updateStoredSnippetUploadStatus: (payload: UpdateStoredSnippetUploadStatusPayload) =>
      invoke(ipcMethods.plakkApiUpdateStoredSnippetUploadStatus, payload),
  },
  storage: {
    uploadStoredSnippetFile: ({ file, ...payload }: RendererStoredSnippetFileUploadPayload) => {
      const filePath = webUtils.getPathForFile(file);
      if (!filePath) return Promise.reject(new Error("Choose a local file to upload."));
      return invoke(ipcMethods.storageUploadStoredSnippetFile, { ...payload, filePath });
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
