import type { IpcEventPayload, IpcResult } from "../ipc/contracts.ts";
import type { ipcEvents, ipcMethods } from "../ipc/contracts.ts";
import type { UserConfig, UserConfigPatch } from "../userConfig.ts";

export {};

type AuthStatus = IpcResult<typeof ipcMethods.authGet>;
type AuthError = IpcEventPayload<typeof ipcEvents.authError>;
type ClipboardPaste = IpcEventPayload<typeof ipcEvents.clipboardPaste>;

declare global {
  interface Window {
    ipc: {
      auth: {
        getAuth: () => Promise<AuthStatus>;
        onError: (callback: (error: AuthError) => void) => () => void;
        onStatusChanged: (callback: (status: AuthStatus) => void) => () => void;
        signIn: () => Promise<void>;
        signOut: () => Promise<void>;
      };
      clipboard: {
        onPaste: (callback: (content: ClipboardPaste) => void) => () => void;
      };
      openExternal: (url: string) => Promise<void>;
      userConfig: {
        get: () => Promise<UserConfig>;
        reset: () => Promise<UserConfig>;
        set: (patch: UserConfigPatch) => Promise<UserConfig>;
      };
      versions: {
        chrome: string;
        electron: string;
        node: string;
      };
    };
  }
}
