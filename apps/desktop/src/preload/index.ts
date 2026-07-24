import { contextBridge, webUtils } from "electron";
import type {
  AppearancePreference,
  AppearanceState,
  AuthError,
  ClipboardContent,
  LocalState,
  SnippetIngestPayload,
  SnippetIngestResult,
  TrayDroppedItem,
  UserConfig,
  UserConfigPatch,
} from "../ipc/contracts.ts";
import { ipcEvents, ipcMethods } from "../ipc/contracts.ts";
import { invoke, on } from "../ipc/preload.ts";

type RendererSnippetIngestPayload = Pick<
  SnippetIngestPayload,
  "id" | "fileName" | "byteSize" | "mediaType" | "storageProvider"
> &
  (
    | {
        readonly file: File;
        readonly sourceId?: never;
        readonly filePath?: never;
        readonly bytes?: never;
      }
    | {
        readonly sourceId: string;
        readonly file?: never;
        readonly filePath?: never;
        readonly bytes?: never;
      }
    | {
        readonly bytes: Uint8Array;
        readonly file?: never;
        readonly sourceId?: never;
        readonly filePath?: never;
      }
  );

export type DesktopApi = {
  readonly appearance: {
    readonly get: () => Promise<AppearanceState>;
    readonly onChanged: (callback: (state: AppearanceState) => void) => () => void;
    readonly set: (preference: AppearancePreference) => Promise<AppearanceState>;
  };
  readonly auth: {
    readonly onError: (callback: (error: AuthError) => void) => () => void;
    readonly signIn: () => Promise<void>;
    readonly signOut: () => Promise<void>;
  };
  readonly clipboard: {
    readonly read: () => Promise<ClipboardContent>;
    readonly onPaste: (callback: (content: ClipboardContent) => void) => () => void;
  };
  readonly openExternal: (url: string) => Promise<void>;
  readonly localState: {
    readonly get: () => Promise<LocalState>;
    readonly onChanged: (callback: (localState: LocalState) => void) => () => void;
  };
  readonly navigation: {
    readonly onRequested: (callback: (view: "home" | "settings") => void) => () => void;
  };
  readonly snippets: {
    readonly copy: (id: string) => Promise<void>;
    readonly delete: (id: string) => Promise<void>;
    readonly download: (id: string) => Promise<void>;
    readonly discard: (id: string) => Promise<void>;
    readonly ingest: (payload: RendererSnippetIngestPayload) => Promise<SnippetIngestResult>;
    readonly read: (id: string) => Promise<Uint8Array>;
  };
  readonly storage: {
    readonly freeUp: () => Promise<void>;
  };
  readonly tray: {
    readonly onDroppedItem: (callback: (item: TrayDroppedItem) => void) => () => void;
    readonly selectFiles: () => Promise<
      ReadonlyArray<{ sourceId: string; name: string; size: number }>
    >;
  };
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

export const desktopApi = {
  appearance: {
    get: () => invoke(ipcMethods.appearanceGet, undefined),
    onChanged: (callback: (state: AppearanceState) => void) =>
      on(ipcEvents.appearanceChanged, callback),
    set: (preference: AppearancePreference) => invoke(ipcMethods.appearanceSet, preference),
  },
  auth: {
    onError: (callback: (error: AuthError) => void) => on(ipcEvents.authError, callback),
    signIn: () => invoke(ipcMethods.authSignIn, undefined),
    signOut: () => invoke(ipcMethods.authSignOut, undefined),
  },
  clipboard: {
    read: () => invoke(ipcMethods.clipboardRead, undefined),
    onPaste: (callback: (content: ClipboardContent) => void) =>
      on(ipcEvents.clipboardPaste, callback),
  },
  openExternal: (url: string) => invoke(ipcMethods.openExternal, url),
  localState: {
    get: () => invoke(ipcMethods.localStateGet, undefined),
    onChanged: (callback: (localState: LocalState) => void) =>
      on(ipcEvents.localStateChanged, callback),
  },
  navigation: {
    onRequested: (callback: (view: "home" | "settings") => void) =>
      on(ipcEvents.navigate, callback),
  },
  snippets: {
    copy: (snippet) => invoke(ipcMethods.snippetCopy, snippet),
    delete: (snippet) => invoke(ipcMethods.snippetDelete, snippet),
    download: (snippet) => invoke(ipcMethods.snippetDownload, snippet),
    discard: (snippet) => invoke(ipcMethods.snippetDiscard, snippet),
    ingest: ({ file, ...payload }: RendererSnippetIngestPayload) => {
      const invocation =
        payload.bytes !== undefined || payload.sourceId !== undefined
          ? invoke(ipcMethods.snippetIngest, payload)
          : (() => {
              const filePath = file === undefined ? "" : webUtils.getPathForFile(file);
              if (!filePath) return Promise.reject(new Error("Choose a file to add."));
              return invoke(ipcMethods.snippetIngest, { ...payload, filePath });
            })();
      return invocation;
    },
    read: (snippet) => invoke(ipcMethods.snippetRead, snippet),
  },
  storage: {
    freeUp: () => invoke(ipcMethods.storageFreeUp, undefined),
  },
  tray: {
    onDroppedItem: (callback: (item: TrayDroppedItem) => void) =>
      on(ipcEvents.trayDroppedItem, callback),
    selectFiles: () => invoke(ipcMethods.traySelectFiles, undefined),
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
} satisfies DesktopApi;

contextBridge.exposeInMainWorld("ipc", desktopApi);
