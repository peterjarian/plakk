import type { ClipboardContent, UserConfig, UserConfigPatch } from "../ipc/contracts.js";

export {};

declare global {
  interface Window {
    ipc: {
      clipboard: {
        onPaste: (callback: (content: ClipboardContent) => void) => () => void;
      };
      openExternal: (url: string) => Promise<void>;
      openSettings: () => Promise<void>;
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
