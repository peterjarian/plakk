import type { AuthError, AuthStatus } from "../auth.ts";
import type { ClipboardContent } from "../clipboardContent.ts";
import type { UserConfig, UserConfigPatch } from "../userConfig.ts";

export {};

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
        onPaste: (callback: (content: ClipboardContent) => void) => () => void;
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
