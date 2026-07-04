import { contextBridge } from "electron";
import {
  ipcEvents,
  ipcMethods,
  type ClipboardContent,
  type UserConfigPatch,
} from "../ipc/contracts.js";
import { invoke, on } from "../ipc/preload.js";

contextBridge.exposeInMainWorld("ipc", {
  clipboard: {
    onPaste: (callback: (content: ClipboardContent) => void) =>
      on(ipcEvents.clipboardPaste, callback),
  },
  openExternal: (url: string) => invoke(ipcMethods.openExternal, url),
  openSettings: () => invoke(ipcMethods.openSettings, undefined),
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
