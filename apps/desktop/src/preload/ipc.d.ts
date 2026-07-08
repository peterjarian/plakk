import type {
  AccountStatus,
  ApiSnippet,
  CreateStoredSnippetPayload,
  CreateTextSnippetPayload,
  DeleteSnippetPayload,
  GetPipeConnectionStatusPayload,
  ListSnippetsPayload,
  PipeConnection,
  PreparedStorageUpload,
  PrepareStoredSnippetUploadPayload,
  UpdateStoredSnippetUploadStatusPayload,
} from "@plakk/shared/PlakkApi";
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
      plakkApi: {
        createStoredSnippet: (payload: CreateStoredSnippetPayload) => Promise<ApiSnippet>;
        createTextSnippet: (payload: CreateTextSnippetPayload) => Promise<ApiSnippet>;
        deleteSnippet: (payload: DeleteSnippetPayload) => Promise<void>;
        getAccountStatus: () => Promise<AccountStatus>;
        getPipeConnectionStatus: (
          payload: GetPipeConnectionStatusPayload,
        ) => Promise<PipeConnection>;
        listSnippets: (payload: ListSnippetsPayload) => Promise<{ items: Array<ApiSnippet> }>;
        prepareStoredSnippetUpload: (
          payload: PrepareStoredSnippetUploadPayload,
        ) => Promise<PreparedStorageUpload>;
        updateStoredSnippetUploadStatus: (
          payload: UpdateStoredSnippetUploadStatusPayload,
        ) => Promise<ApiSnippet>;
      };
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
