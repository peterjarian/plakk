import "dotenv/config";

import { basename, join, resolve, sep } from "node:path";
import { rm, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { decodeSnippetText, deriveSnippetPresentation, isHttpUrl } from "@plakk/shared";
import { accountCanSyncWithConnection } from "@plakk/shared/PlakkApi";
import { app, BrowserWindow, dialog, Menu, net, protocol, shell } from "electron";
import { Effect, PlatformError, Result, Stream } from "effect";
import type {
  ClipboardContent,
  LocalState as LocalStateValue,
  TrayDroppedItem,
  UserConfig,
} from "../ipc/contracts.ts";
import { ipcEvents, ipcMethods } from "../ipc/contracts.ts";
import { IpcHandlerError, makeHandle, send } from "../ipc/main.ts";
import { AuthService, AuthServiceError } from "./auth/AuthService.ts";
import {
  consumeTemporaryClipboardFile,
  readClipboard,
  writeClipboard,
  writeSnippetToClipboard,
  type NativeClipboardContent,
} from "./clipboard.ts";
import { UserConfigStore } from "./UserConfigStore.ts";
import { createToolbarWidgetLifecycle, isReloadShortcut } from "./lifecycle.ts";
import { LocalState } from "./local-state/LocalState.ts";
import { runEffect, runtime } from "./runtime.ts";
import { DesktopSession } from "./session/DesktopSession.ts";
import { SnippetHydrationEngine } from "./snippets/hydration/SnippetHydration.ts";
import { getManagedSnippetBytes } from "./snippets/replica/read.ts";
import { NativeFileSources } from "./snippets/sources/NativeFileSources.ts";
import { SnippetUploadEngine } from "./snippets/upload/SnippetUploadEngine.ts";
import { SnippetDeletion } from "./snippets/deletion/SnippetDeletion.ts";
import { snippetUploadFailureMessage } from "./snippets/upload/SnippetUploadEngineLive.ts";
import { createTrayWindowController } from "./tray/window.ts";

const linuxDesktopName = process.env.PLAKK_LINUX_DESKTOP_NAME;
if (process.platform === "linux" && linuxDesktopName !== undefined) {
  app.setDesktopName(linuxDesktopName);
}

const handle = makeHandle(runtime);

const asIpcFailure =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new IpcHandlerError({ cause, message })));

const rendererScheme = "plakk-app";
const rendererHost = "renderer";

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

handle(ipcMethods.openExternal, (url) =>
  !isHttpUrl(url)
    ? Effect.void
    : Effect.tryPromise({
        try: () => shell.openExternal(url),
        catch: (cause) => new IpcHandlerError({ cause, message: "Could not open this link." }),
      }),
);

const getLocalState = LocalState.use((localState) => localState.current);

const applyUserConfigToTray = Effect.fn("Desktop.applyUserConfigToTray")(function* (
  config: UserConfig,
) {
  yield* Effect.sync(() => {
    toolbarWidgetLifecycle?.applyToolbarWidgetPreference(config.toolbarWidgetEnabled);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Desktop preference was saved but could not be applied to the Tray", {
        cause,
      }),
    ),
  );
});

handle(ipcMethods.localStateGet, () => getLocalState);

handle(ipcMethods.snippetIngest, (payload, event) =>
  Effect.gen(function* () {
    const sources = yield* NativeFileSources;
    const nativeSource = "sourceId" in payload ? sources.take(payload.sourceId) : undefined;
    const resolvedPayload =
      "sourceId" in payload
        ? nativeSource === undefined
          ? undefined
          : {
              id: payload.id,
              fileName: payload.fileName,
              byteSize: payload.byteSize,
              mediaType: payload.mediaType,
              storageProvider: payload.storageProvider,
              filePath: nativeSource.filePath,
            }
        : payload;
    const cleanup = Effect.gen(function* () {
      const temporaryPath =
        nativeSource?.temporary === true
          ? nativeSource.filePath
          : resolvedPayload !== undefined &&
              "filePath" in resolvedPayload &&
              consumeTemporaryClipboardFile(resolvedPayload.filePath)
            ? resolvedPayload.filePath
            : undefined;
      if (temporaryPath === undefined) return;
      yield* Effect.tryPromise(() => rm(temporaryPath, { force: true })).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not remove a temporary clipboard file", { cause }),
        ),
      );
    });
    return yield* Effect.gen(function* () {
      if (resolvedPayload === undefined) {
        return { status: "FAILED", message: "Choose the file again before adding it." } as const;
      }
      if (
        trayWindowController?.ownsWebContents(event.sender) === true &&
        !trayWindowController.isIngestionEnabled()
      ) {
        return {
          status: "FAILED",
          message: "Adding is paused until the account is ready.",
        } as const;
      }
      const engine = yield* SnippetUploadEngine;
      const session = yield* DesktopSession;
      return yield* session
        .withCurrentAccount((account) => {
          if (account.accessToken === null) {
            return Effect.succeed({
              status: "FAILED" as const,
              message: "Reconnect storage before adding snippets.",
            });
          }
          return engine
            .ingest({ id: account.id, accessToken: account.accessToken }, resolvedPayload)
            .pipe(
              Effect.as({ status: "ENQUEUED" } as const),
              Effect.catch((error) =>
                Effect.succeed({
                  status: "FAILED",
                  message: snippetUploadFailureMessage(error),
                } as const),
              ),
            );
        })
        .pipe(
          Effect.catchTag("DesktopSessionCommandError", () =>
            Effect.succeed({
              status: "FAILED",
              message: "Sign in before adding snippets.",
            } as const),
          ),
        );
    }).pipe(Effect.ensuring(cleanup));
  }),
);

handle(ipcMethods.snippetDiscard, (id) =>
  Effect.gen(function* () {
    const engine = yield* SnippetUploadEngine;
    const session = yield* DesktopSession;
    yield* session
      .withCurrentAccount((account) => engine.discard(account.id, id))
      .pipe(asIpcFailure("Could not discard this local snippet."));
  }),
);

handle(ipcMethods.snippetDelete, (id) =>
  Effect.gen(function* () {
    const deletion = yield* SnippetDeletion;
    const session = yield* DesktopSession;
    yield* session
      .withCurrentAccount((account) => deletion.delete(account, id))
      .pipe(asIpcFailure("Could not delete this snippet."));
  }),
);

handle(ipcMethods.snippetDownload, (id) =>
  Effect.gen(function* () {
    const engine = yield* SnippetHydrationEngine;
    const session = yield* DesktopSession;
    yield* session
      .withCurrentAccount((account) => {
        if (account.accessToken === null) {
          return Effect.fail(
            new IpcHandlerError({
              cause: null,
              message: "Reconnect storage before downloading this snippet.",
            }),
          );
        }
        return engine
          .download({ id: account.id, accessToken: account.accessToken }, id)
          .pipe(Effect.mapError((cause) => new IpcHandlerError({ cause, message: cause.reason })));
      })
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof IpcHandlerError
            ? cause
            : new IpcHandlerError({
                cause,
                message: "Reconnect storage before downloading this snippet.",
              }),
        ),
      );
  }),
);

handle(ipcMethods.storageFreeUp, () =>
  Effect.gen(function* () {
    const hydration = yield* SnippetHydrationEngine;
    const session = yield* DesktopSession;
    yield* session
      .withCurrentAccount((account) => hydration.freeUpSpace(account.id))
      .pipe(asIpcFailure("Could not free up Plakk storage."));
  }),
);

const findSnippet = Effect.fn("LocalState.findSnippet")(function* (id: string) {
  const localState = yield* LocalState;
  const session = yield* DesktopSession;
  return yield* session
    .withCurrentAccount(
      Effect.fn("LocalState.findAuthorizedSnippet")(function* (account) {
        const current = yield* localState.current;
        const snippets = current.account?.id === account.id ? current.snippets : [];
        const snippet = snippets.find((item) => item.id === id);
        if (snippet === undefined) {
          return yield* new IpcHandlerError({ cause: null, message: "Snippet was not found." });
        }
        return { account, snippet };
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        cause instanceof IpcHandlerError
          ? cause
          : new IpcHandlerError({ cause, message: "Sign in to load stored snippets." }),
      ),
    );
});

handle(ipcMethods.snippetCopy, (id) =>
  Effect.gen(function* () {
    const { account, snippet } = yield* findSnippet(id);
    const { bytes } = yield* Effect.scoped(getManagedSnippetBytes(account, id, snippet)).pipe(
      asIpcFailure("Could not load this snippet."),
    );
    const presentation = deriveSnippetPresentation({ fileName: snippet.fileName, content: bytes });
    if (presentation.type === "text" || presentation.type === "hyperlink") {
      const text = decodeSnippetText(bytes);
      if (text !== null) {
        return yield* writeClipboard({ type: "text", text }).pipe(
          asIpcFailure("Could not copy this snippet."),
        );
      }
    }
    return yield* writeSnippetToClipboard({
      bytes,
      fileName: snippet.fileName,
      contentType: null,
    }).pipe(asIpcFailure("Could not copy this snippet."));
  }),
);

handle(ipcMethods.snippetRead, (id) =>
  Effect.gen(function* () {
    const { account, snippet } = yield* findSnippet(id);
    const { bytes } = yield* Effect.scoped(getManagedSnippetBytes(account, id, snippet)).pipe(
      asIpcFailure("Could not load this snippet."),
    );
    return bytes;
  }),
);

handle(ipcMethods.clipboardRead, () =>
  readClipboard().pipe(
    Effect.flatMap(projectClipboardContent),
    asIpcFailure("Could not read the clipboard."),
  ),
);

const projectNativeFile = Effect.fn("NativeFileSources.projectFile")(function* (path: string) {
  const sources = yield* NativeFileSources;
  const file = yield* Effect.tryPromise(() => stat(path));
  const sourceId = yield* sources.register(path);
  return { sourceId, name: basename(path), size: file.size };
});

handle(ipcMethods.traySelectFiles, (_payload, event) =>
  Effect.gen(function* () {
    if (
      trayWindowController?.ownsWebContents(event.sender) !== true ||
      !trayWindowController.isIngestionEnabled()
    ) {
      return [];
    }
    const result = yield* Effect.tryPromise({
      try: () => dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] }),
      catch: (cause) => new IpcHandlerError({ cause, message: "Could not choose a file." }),
    });
    if (result.canceled) return [];
    return yield* Effect.forEach(
      result.filePaths,
      (path) => projectNativeFile(path).pipe(asIpcFailure("Could not read the selected file.")),
      { concurrency: "unbounded" },
    );
  }),
);

const authFailureMessage = (cause: unknown, fallback: string) =>
  cause instanceof AuthServiceError ? cause.message : fallback;

const withAuthIpcError = Effect.fn("withAuthIpcError")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback: string,
): Effect.fn.Return<A, IpcHandlerError, R> {
  return yield* effect.pipe(
    Effect.mapError(
      (cause) => new IpcHandlerError({ cause, message: authFailureMessage(cause, fallback) }),
    ),
  );
});

handle(ipcMethods.authSignIn, () =>
  Effect.gen(function* () {
    const callbackUrl = yield* withAuthIpcError(
      AuthService.use((auth) => auth.callbackUrl),
      "Desktop auth is not configured.",
    );
    yield* Effect.try({
      try: () => registerAuthCallbackProtocol(callbackUrl),
      catch: (cause) =>
        new IpcHandlerError({ cause, message: "Could not register desktop sign-in." }),
    });
    const authorizationUrl = yield* withAuthIpcError(
      AuthService.use((auth) => auth.startSignIn()),
      "Could not start sign-in.",
    );
    yield* Effect.tryPromise({
      try: () => shell.openExternal(authorizationUrl),
      catch: (cause) =>
        new IpcHandlerError({ cause, message: "Could not open the desktop sign-in URL." }),
    });
  }),
);

handle(ipcMethods.authSignOut, () =>
  DesktopSession.use((session) => session.signOut).pipe(
    Effect.mapError((cause) => new IpcHandlerError({ cause, message: cause.reason })),
  ),
);

handle(ipcMethods.userConfigGet, () =>
  UserConfigStore.use((store) => store.get).pipe(
    asIpcFailure("Could not load desktop preferences."),
  ),
);

handle(ipcMethods.userConfigSet, (patch) =>
  UserConfigStore.use((store) => store.set(patch)).pipe(
    Effect.tap(applyUserConfigToTray),
    asIpcFailure("Could not save desktop preferences."),
  ),
);

handle(ipcMethods.userConfigReset, () =>
  UserConfigStore.use((store) => store.reset).pipe(
    Effect.tap(applyUserConfigToTray),
    asIpcFailure("Could not reset desktop preferences."),
  ),
);

type RendererView = "home" | "settings" | "tray" | "welcome";

let mainWindow: BrowserWindow | undefined;
let trayWindowController: ReturnType<typeof createTrayWindowController> | undefined;
let toolbarWidgetLifecycle: ReturnType<typeof createToolbarWidgetLifecycle> | undefined;
let isQuitting = false;

app.setName(app.isPackaged ? "Plakk" : "Plakk (Dev)");

const pendingOpenUrls = new Set<string>();

function loadRenderer(window: BrowserWindow, view?: RendererView) {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    if (view === undefined) {
      url.searchParams.delete("view");
    } else {
      url.searchParams.set("view", view);
    }
    return window.loadURL(url.toString());
  }

  const url = new URL(`${rendererScheme}://${rendererHost}/index.html`);
  if (view !== undefined) url.searchParams.set("view", view);
  return window.loadURL(url.toString());
}

function registerRendererProtocol(): void {
  const rendererRoot = resolve(__dirname, "../renderer");

  protocol.handle(rendererScheme, (request) => {
    const url = new URL(request.url);
    if (url.host !== rendererHost) return new Response(null, { status: 404 });

    const filePath = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`);
    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${sep}`)) {
      return new Response(null, { status: 404 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function guardExternalWindows(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isSameRendererNavigation(window.webContents.getURL(), url)) return;

    event.preventDefault();
    if (isHttpUrl(url)) void shell.openExternal(url);
  });

  window.webContents.on("before-input-event", (event, input) => {
    if (isReloadShortcut(input)) event.preventDefault();
  });
}

function isSameRendererNavigation(current: string, next: string) {
  try {
    const currentUrl = new URL(current);
    const nextUrl = new URL(next);

    if (currentUrl.protocol === `${rendererScheme}:` || nextUrl.protocol === `${rendererScheme}:`) {
      return currentUrl.protocol === nextUrl.protocol && currentUrl.host === nextUrl.host;
    }

    if (currentUrl.protocol === "file:" || nextUrl.protocol === "file:") {
      return currentUrl.protocol === nextUrl.protocol && currentUrl.pathname === nextUrl.pathname;
    }

    return currentUrl.origin === nextUrl.origin;
  } catch {
    return false;
  }
}

const createWindow = (view?: RendererView): void => {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (view === "home" || view === "settings") {
      const currentView = new URL(mainWindow.webContents.getURL()).searchParams.get("view");
      if (currentView === "home" || currentView === "settings") {
        send(mainWindow.webContents, ipcEvents.navigate, view);
      } else {
        void loadRenderer(mainWindow, view);
      }
    } else if (view !== undefined) {
      void loadRenderer(mainWindow, view);
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 680,
    height: 620,
    minWidth: 520,
    minHeight: 520,
    maxWidth: 720,
    maxHeight: 720,
    resizable: true,
    fullscreenable: false,
    maximizable: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 24, y: 22 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;

    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.once("closed", () => {
    mainWindow = undefined;
  });
  mainWindow.on("focus", () => runtime.runFork(DesktopSession.use((session) => session.refresh)));

  guardExternalWindows(mainWindow);

  void loadRenderer(mainWindow, view);
};

function openSettingsView() {
  createWindow("settings");
}

function revealMainWindow() {
  createWindow();
  mainWindow?.show();
  mainWindow?.focus();
}

function registerAuthCallbackProtocol(callbackUrl: string): void {
  const redirectUrl = new URL(callbackUrl);

  if (["http:", "https:", "file:"].includes(redirectUrl.protocol)) {
    throw new Error("Desktop auth callback URL must use a private app scheme.");
  }

  const scheme = redirectUrl.protocol.slice(0, -1);
  const registered =
    process.defaultApp === true && process.argv[1] !== undefined
      ? app.setAsDefaultProtocolClient(scheme, process.execPath, [resolve(process.argv[1]!)])
      : app.setAsDefaultProtocolClient(scheme);

  if (!registered) {
    throw new Error("Could not register the desktop auth callback URL.");
  }
}

function broadcastLocalState(localState: LocalStateValue): void {
  const canSync =
    localState.capability.status === "ONLINE" &&
    accountCanSyncWithConnection(localState.capability.account, localState.capability.connection);
  toolbarWidgetLifecycle?.applyAccountState({
    canIngest: canSync,
    user: localState.account,
  });
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      send(window.webContents, ipcEvents.localStateChanged, localState);
    }
  }
}

function broadcastAuthError(message: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      send(window.webContents, ipcEvents.authError, { message });
    }
  }
}

function broadcastTrayDroppedItem(item: TrayDroppedItem): void {
  if (trayWindowController?.isIngestionEnabled() !== true) return;
  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed() && trayWindowController.ownsWebContents(window.webContents))
      send(window.webContents, ipcEvents.trayDroppedItem, item);
}

const projectClipboardContent = Effect.fn("NativeFileSources.projectClipboardContent")(function* (
  content: NativeClipboardContent,
): Effect.fn.Return<ClipboardContent, PlatformError.PlatformError, NativeFileSources> {
  const sources = yield* NativeFileSources;
  if (content.type === "image") {
    return {
      type: "image",
      dataUrl: content.dataUrl,
      sourceId: yield* sources.register(content.path, { temporary: true }),
      width: content.width,
      height: content.height,
    };
  }
  if (content.type === "file") {
    return {
      type: "file",
      name: content.name,
      sourceId: yield* sources.register(content.path),
      extension: content.extension,
      ...(content.size === undefined ? {} : { size: content.size }),
    };
  }
  return content;
});

async function handleAuthUrls(values: readonly string[]): Promise<boolean> {
  for (const rawUrl of values) {
    pendingOpenUrls.add(rawUrl);
  }

  let handled = false;
  if (!app.isReady()) return values.length > 0;

  for (const rawUrl of pendingOpenUrls) {
    pendingOpenUrls.delete(rawUrl);

    const result = await runEffect(
      Effect.result(
        DesktopSession.use((desktopSession) => desktopSession.handleCallbackUrl(rawUrl)),
      ),
    );

    if (!Result.isSuccess(result)) {
      handled = true;
      revealMainWindow();
      broadcastAuthError(authFailureMessage(result.failure, "Could not complete sign-in."));
      continue;
    }

    const session = result.success;
    if (session !== null) {
      handled = true;
      revealMainWindow();
    }
  }

  return handled;
}

function pasteIntoFocusedWindow(): void {
  const window = BrowserWindow.getFocusedWindow();
  if (window === null) return;
  if (
    trayWindowController?.ownsWebContents(window.webContents) === true &&
    !trayWindowController.isIngestionEnabled()
  )
    return;

  void runEffect(readClipboard()).then((content) => {
    if (content.type === "empty" || window.isDestroyed()) return;
    void runEffect(projectClipboardContent(content)).then((projected) => {
      if (!window.isDestroyed()) send(window.webContents, ipcEvents.clipboardPaste, projected);
    });
  });
}

app.on("open-url", (event, rawUrl) => {
  event.preventDefault();
  void handleAuthUrls([rawUrl]);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    void handleAuthUrls(argv).then((handled) => {
      if (!handled) revealMainWindow();
    });
  });

  void app.whenReady().then(async () => {
    registerRendererProtocol();

    // Reconcile the locally persisted account owner before any renderer can read cached Local State.
    // Network credential refresh continues in the background so it cannot prevent the UI opening.
    const [initialSession, initialUserConfig] = await Promise.all([
      runEffect(Effect.result(DesktopSession.use((session) => session.start))),
      runEffect(Effect.result(UserConfigStore.use((store) => store.get))),
    ]);
    if (Result.isFailure(initialUserConfig)) {
      await runEffect(
        Effect.logError("Could not load the Toolbar widget preference; leaving the Tray disabled", {
          cause: initialUserConfig.failure,
        }),
      );
    }

    runtime.runFork(
      LocalState.use((localState) =>
        localState.changes.pipe(
          Stream.runForEach((value) => Effect.sync(() => broadcastLocalState(value))),
        ),
      ),
    );
    runtime.runFork(
      DesktopSession.use((session) =>
        session.issues.pipe(
          Stream.runForEach((message) => Effect.sync(() => broadcastAuthError(message))),
        ),
      ),
    );

    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { label: "Settings", accelerator: "CommandOrControl+,", click: openSettingsView },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { role: "fileMenu" },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { label: "Paste", accelerator: "CommandOrControl+V", click: pasteIntoFocusedWindow },
            { role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [{ role: "toggleDevTools" }],
        },
        { role: "windowMenu" },
      ]),
    );

    trayWindowController = createTrayWindowController({
      guardExternalWindows,
      loadTrayRenderer: (window) => loadRenderer(window, "tray"),
      onAccountRefreshRequested: () =>
        runtime.runFork(DesktopSession.use((session) => session.refresh)),
      onRendererLoaded: () => runtime.runFork(DesktopSession.use((session) => session.refresh)),
      onDropFiles: ({ files }) => {
        void runEffect(Effect.forEach(files, projectNativeFile, { concurrency: "unbounded" })).then(
          (files) => broadcastTrayDroppedItem({ type: "files", files }),
        );
      },
      onDropText: ({ text }) => {
        if (text.trim()) broadcastTrayDroppedItem({ type: "text", text });
      },
      preloadPath: join(__dirname, "../preload/index.cjs"),
    });
    toolbarWidgetLifecycle = createToolbarWidgetLifecycle(
      trayWindowController,
      Result.isSuccess(initialUserConfig) ? initialUserConfig.success.toolbarWidgetEnabled : false,
    );
    createWindow();
    runtime.runFork(
      LocalState.use((localState) =>
        localState.current.pipe(
          Effect.tap((value) => Effect.sync(() => broadcastLocalState(value))),
        ),
      ),
    );
    if (Result.isFailure(initialSession)) {
      broadcastAuthError("Plakk could not finish reconciling the local account.");
    }
    void handleAuthUrls(process.argv);

    app.on("activate", () => {
      createWindow();
    });
  });
}

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  // Keep the tray and Electron-main work running until the user explicitly quits.
});
