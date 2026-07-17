import { contextBridge, webUtils } from "electron";
import type {
  AuthError,
  AuthStatus,
  ClipboardContent,
  DesktopSnippet,
  SnippetIngestPayload,
  SnippetIngestResult,
  TrayDroppedItem,
  TrayAccountState,
  UserConfig,
  UserConfigPatch,
} from "../ipc/contracts.ts";
import { ipcEvents, ipcMethods } from "../ipc/contracts.ts";
import { invoke, on } from "../ipc/preload.ts";

const plakkRpcUrl = process.env.PLAKK_RPC_URL ?? "https://app.plakk.io/api/rpc";

type RendererSnippetIngestPayload = Pick<
  SnippetIngestPayload,
  "id" | "fileName" | "byteSize" | "mediaType" | "storageProvider"
> &
  (
    | { readonly file: File; readonly filePath?: never; readonly bytes?: never }
    | { readonly filePath: string; readonly file?: never; readonly bytes?: never }
    | { readonly bytes: Uint8Array; readonly file?: never; readonly filePath?: never }
  );

export type DesktopApi = {
  readonly auth: {
    readonly getAuth: () => Promise<AuthStatus>;
    readonly onError: (callback: (error: AuthError) => void) => () => void;
    readonly onStatusChanged: (callback: (status: AuthStatus) => void) => () => void;
    readonly signIn: () => Promise<void>;
    readonly signOut: () => Promise<void>;
  };
  readonly clipboard: {
    readonly read: () => Promise<ClipboardContent>;
    readonly onPaste: (callback: (content: ClipboardContent) => void) => () => void;
  };
  readonly openExternal: (url: string) => Promise<void>;
  readonly navigation: {
    readonly onRequested: (callback: (view: "home" | "settings") => void) => () => void;
  };
  readonly snippets: {
    readonly cancel: (id: string) => Promise<void>;
    readonly copy: (id: string) => Promise<void>;
    readonly delete: (id: string) => Promise<void>;
    readonly download: (id: string) => Promise<void>;
    readonly discard: (id: string) => Promise<void>;
    readonly ingest: (payload: RendererSnippetIngestPayload) => Promise<SnippetIngestResult>;
    readonly list: () => Promise<ReadonlyArray<DesktopSnippet>>;
    readonly onChanged: (callback: (items: ReadonlyArray<DesktopSnippet>) => void) => () => void;
    readonly read: (id: string) => Promise<Uint8Array>;
    readonly retry: (id: string) => Promise<void>;
  };
  readonly tray: {
    readonly getAccountState: () => Promise<TrayAccountState>;
    readonly onAccountStateChanged: (callback: (state: TrayAccountState) => void) => () => void;
    readonly onDroppedItem: (callback: (item: TrayDroppedItem) => void) => () => void;
    readonly selectFiles: () => Promise<
      ReadonlyArray<{ path: string; name: string; size: number }>
    >;
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
    read: () => invoke(ipcMethods.clipboardRead, undefined),
    onPaste: (callback: (content: ClipboardContent) => void) =>
      on(ipcEvents.clipboardPaste, callback),
  },
  openExternal: (url: string) => invoke(ipcMethods.openExternal, url),
  navigation: {
    onRequested: (callback: (view: "home" | "settings") => void) =>
      on(ipcEvents.navigate, callback),
  },
  snippets: {
    cancel: (snippet) => invoke(ipcMethods.snippetCancel, snippet),
    copy: (snippet) => invoke(ipcMethods.snippetCopy, snippet),
    delete: (snippet) => invoke(ipcMethods.snippetDelete, snippet),
    download: (snippet) => invoke(ipcMethods.snippetDownload, snippet),
    discard: (snippet) => invoke(ipcMethods.snippetDiscard, snippet),
    ingest: ({ file, ...payload }: RendererSnippetIngestPayload) => {
      const invocation =
        payload.bytes !== undefined
          ? invoke(ipcMethods.snippetIngest, payload)
          : (() => {
              const filePath =
                payload.filePath ?? (file === undefined ? "" : webUtils.getPathForFile(file));
              if (!filePath) return Promise.reject(new Error("Choose a file to add."));
              return invoke(ipcMethods.snippetIngest, { ...payload, filePath });
            })();
      return invocation;
    },
    list: () => invoke(ipcMethods.snippetList, undefined),
    onChanged: (callback) => on(ipcEvents.snippetReplicaChanged, callback),
    read: (snippet) => invoke(ipcMethods.snippetRead, snippet),
    retry: (snippet) => invoke(ipcMethods.snippetRetry, snippet),
  },
  tray: {
    getAccountState: () => invoke(ipcMethods.trayGetAccountState, undefined),
    onAccountStateChanged: (callback: (state: TrayAccountState) => void) =>
      on(ipcEvents.trayAccountStateChanged, callback),
    onDroppedItem: (callback: (item: TrayDroppedItem) => void) =>
      on(ipcEvents.trayDroppedItem, callback),
    selectFiles: () => invoke(ipcMethods.traySelectFiles, undefined),
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
