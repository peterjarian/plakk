import "dotenv/config";

import { basename, join, resolve, sep } from "node:path";
import { rm, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isHttpUrl } from "@plakk/shared";
import { accountCanSync, type ApiSnippet } from "@plakk/shared/PlakkApi";
import { SnippetReplica, runSnippetReplicaSync } from "@plakk/shared/SnippetReplica";
import { app, BrowserWindow, dialog, Menu, net, protocol, shell } from "electron";
import { Effect, Result, Stream } from "effect";
import * as Fiber from "effect/Fiber";
import type { AuthStatus, TrayAccountState, TrayDroppedItem } from "../ipc/contracts.ts";
import { ipcEvents, ipcMethods } from "../ipc/contracts.ts";
import { handle, send } from "../ipc/main.ts";
import { StorageUpload, type StorageUploadResult } from "../storageUpload.ts";
import { getAccountStatus, isUnauthenticatedAccountError } from "./accountStatus.ts";
import { AuthService } from "./auth/AuthService.ts";
import {
  consumeTemporaryClipboardFile,
  readClipboard,
  writeClipboard,
  writeSnippetToClipboard,
} from "./clipboard.ts";
import { createTrayWindowController } from "./trayWindow.ts";
import { isReloadShortcut, reconcileTrayAuth } from "./lifecycle.ts";
import { UserConfigStore } from "./UserConfigStore.ts";
import { runEffect, runtime } from "./runtime.ts";
import {
  ActiveSnippetAccount,
  getManagedSnippetBytes,
  getReplicaItems,
  getReplicaSnippet,
} from "./snippetReplica.ts";

const rendererScheme = "plakk-app";
const rendererHost = "renderer";
const activeUploads = new Map<string, Fiber.Fiber<StorageUploadResult, unknown>>();

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

handle(ipcMethods.openExternal, (url) => {
  if (!isHttpUrl(url)) return;
  return shell.openExternal(url);
});

handle(ipcMethods.storageUploadPreparedFile, async (payload, event) => {
  if (
    trayWindowController?.ownsWebContents(event.sender) === true &&
    !trayWindowController.isIngestionEnabled()
  ) {
    throw new Error("Tray ingestion is unavailable until the account is ready.");
  }
  const upload = StorageUpload.use((storage) =>
    storage.upload(payload, (progress) =>
      send(event.sender, ipcEvents.storageUploadProgress, { id: payload.id, progress }),
    ),
  );
  const fiber = runtime.runFork(upload);
  activeUploads.set(payload.id, fiber);
  try {
    return await runEffect(Fiber.join(fiber));
  } finally {
    if (activeUploads.get(payload.id) === fiber) activeUploads.delete(payload.id);
    if ("filePath" in payload && consumeTemporaryClipboardFile(payload.filePath)) {
      void rm(payload.filePath, { force: true });
    }
  }
});

handle(ipcMethods.storageCancelUpload, (id) => {
  const fiber = activeUploads.get(id);
  if (fiber !== undefined) runtime.runFork(Fiber.interrupt(fiber));
});

handle(ipcMethods.snippetCopy, async (id) => {
  const account = activeSnippetAccount();
  if (account === null) throw new Error("Sign in to load stored snippets.");
  const snippet = await runEffect(getReplicaSnippet(account.id, id));
  if (snippet.kind === "LINK") {
    await runEffect(writeClipboard({ type: "text", text: snippet.title }));
    return;
  }

  const { bytes } = await runEffect(Effect.scoped(getManagedSnippetBytes(account, id)));
  if (snippet.kind === "TEXT") {
    await runEffect(writeClipboard({ type: "text", text: new TextDecoder().decode(bytes) }));
    return;
  }
  await runEffect(
    writeSnippetToClipboard({
      bytes,
      kind: snippet.kind,
      fileName: snippet.fileName,
      contentType: snippet.contentType,
    }),
  );
});

handle(ipcMethods.snippetRead, async (id) => {
  const account = activeSnippetAccount();
  if (account === null) throw new Error("Sign in to load stored snippets.");
  return runEffect(Effect.scoped(getManagedSnippetBytes(account, id))).then(({ bytes }) => bytes);
});

handle(ipcMethods.snippetList, () =>
  activeSnippetAccountId === undefined ? [] : runEffect(getReplicaItems(activeSnippetAccountId)),
);

handle(ipcMethods.clipboardRead, () => runEffect(readClipboard()));

handle(ipcMethods.traySelectFiles, async (_payload, event) => {
  if (
    trayWindowController?.ownsWebContents(event.sender) !== true ||
    !trayWindowController.isIngestionEnabled()
  )
    return [];
  const result = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
  if (result.canceled) return [];
  return Promise.all(
    result.filePaths.map(async (path) => ({
      path,
      name: basename(path),
      size: (await stat(path)).size,
    })),
  );
});

function authErrorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof error.reason === "string"
  ) {
    return error.reason;
  }

  return fallback;
}

async function runAuth<A, E>(
  effect: Effect.Effect<A, E, AuthService | UserConfigStore>,
  fallback: string,
): Promise<A> {
  const result = await runEffect(Effect.result(effect));

  if (!Result.isSuccess(result)) {
    throw new Error(authErrorMessage(result.failure, fallback));
  }

  return result.success;
}

function authStatus(session: { accessToken: string; user: AuthStatus["user"] } | null): AuthStatus {
  return {
    accessToken: session?.accessToken ?? null,
    user: session?.user ?? null,
  };
}

handle(ipcMethods.authGet, () =>
  runAuth(
    AuthService.use((auth) => auth.getSession().pipe(Effect.map(authStatusForSession))),
    "Could not check session.",
  ).then(
    (status) => {
      applyAuthStatus(status);
      return status;
    },
    (error) => {
      const paused = { accessToken: null, user: currentAuthStatus.user } satisfies AuthStatus;
      applyAuthStatus(paused);
      if (paused.user !== null) return paused;
      throw error;
    },
  ),
);

handle(ipcMethods.authSignIn, async () => {
  const callbackUrl = await runAuth(
    AuthService.use((auth) => auth.callbackUrl),
    "Desktop auth is not configured.",
  );
  registerAuthCallbackProtocol(callbackUrl);

  const authorizationUrl = await runAuth(
    AuthService.use((auth) => auth.startSignIn()),
    "Could not start sign-in.",
  );

  try {
    await shell.openExternal(authorizationUrl);
  } catch (error) {
    throw new Error(authErrorMessage(error, "Could not open the desktop sign-in URL."));
  }
});

handle(ipcMethods.authSignOut, async () => {
  await runAuth(
    AuthService.use((auth) => auth.signOut()),
    "Could not sign out.",
  );
  if (snippetAccountPersistenceFiber !== undefined) {
    await runEffect(Fiber.interrupt(snippetAccountPersistenceFiber));
    snippetAccountPersistenceFiber = undefined;
  }
  await runEffect(ActiveSnippetAccount.use((account) => account.set(null)));
  activeSnippetAccountId = undefined;
  const status = authStatus(null);
  applyAuthStatus(status);
  broadcastSnippetReplica([]);
  broadcastAuthStatus(status);
});

handle(ipcMethods.userConfigGet, () => runEffect(UserConfigStore.use((store) => store.get)));

handle(ipcMethods.userConfigSet, (patch) =>
  runEffect(UserConfigStore.use((store) => store.set(patch))),
);

handle(ipcMethods.userConfigReset, () => runEffect(UserConfigStore.use((store) => store.reset)));

type RendererView = "home" | "settings" | "tray" | "welcome";

let mainWindow: BrowserWindow | undefined;
let trayWindowController: ReturnType<typeof createTrayWindowController> | undefined;
let isQuitting = false;
let currentAuthStatus = authStatus(null);
let currentTrayAccountState: TrayAccountState = { kind: "loading" };
let trayRefreshGeneration = 0;
let activeSnippetAccountId: string | undefined;
let snippetSyncFiber: Fiber.Fiber<void, unknown> | undefined;
let snippetAccountPersistenceFiber: Fiber.Fiber<void, unknown> | undefined;

handle(ipcMethods.trayGetAccountState, (_payload, event) =>
  trayWindowController?.ownsWebContents(event.sender) === true
    ? currentTrayAccountState
    : ({ kind: "failed" } satisfies TrayAccountState),
);

function sendTrayAccountState(state: TrayAccountState) {
  currentTrayAccountState = state;
  const window = BrowserWindow.getAllWindows().find((candidate) =>
    trayWindowController?.ownsWebContents(candidate.webContents),
  );
  if (window !== undefined) send(window.webContents, ipcEvents.trayAccountStateChanged, state);
}

function applyAuthStatus(status: AuthStatus) {
  const changed =
    currentAuthStatus.accessToken !== status.accessToken ||
    currentAuthStatus.user?.id !== status.user?.id;
  currentAuthStatus = status;
  if (status.user !== null) {
    activeSnippetAccountId = status.user.id;
    if (status.accessToken !== null) {
      if (snippetAccountPersistenceFiber !== undefined)
        runtime.runFork(Fiber.interrupt(snippetAccountPersistenceFiber));
      snippetAccountPersistenceFiber = runtime.runFork(
        ActiveSnippetAccount.use((account) => account.set(status.user)).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not remember the active snippet account", { error }),
          ),
        ),
      );
    }
  }
  if (changed) {
    trayRefreshGeneration += 1;
    if (snippetSyncFiber !== undefined) runtime.runFork(Fiber.interrupt(snippetSyncFiber));
    snippetSyncFiber =
      status.user === null || status.accessToken === null
        ? undefined
        : runtime.runFork(
            runSnippetReplicaSync({ id: status.user.id, accessToken: status.accessToken }),
          );
  }
  reconcileTrayAuth(status, trayWindowController);
  if (status.user === null) {
    sendTrayAccountState({ kind: "loading" });
  } else if (status.accessToken === null) {
    trayWindowController?.setAccountState(true, false);
    sendTrayAccountState({ kind: "failed" });
  } else if (changed) {
    void refreshTrayAccountState();
  }
}

async function refreshTrayAccountState() {
  const status = currentAuthStatus;
  if (status.accessToken === null || status.user === null || trayWindowController === undefined)
    return;

  const generation = ++trayRefreshGeneration;
  trayWindowController.setAccountState(false, false);
  sendTrayAccountState({ kind: "loading" });

  const result = await runEffect(
    Effect.result(Effect.scoped(getAccountStatus(status.accessToken))),
  );
  if (generation !== trayRefreshGeneration || currentAuthStatus.accessToken !== status.accessToken)
    return;

  if (Result.isSuccess(result)) {
    const account = result.success;
    trayWindowController.setAccountState(true, accountCanSync(account));
    sendTrayAccountState({ kind: "resolved", account });
    return;
  }

  if (isUnauthenticatedAccountError(result.failure)) {
    const paused = { accessToken: null, user: status.user } satisfies AuthStatus;
    applyAuthStatus(paused);
    broadcastAuthStatus(paused);
    return;
  }

  trayWindowController.setAccountState(true, false);
  sendTrayAccountState({ kind: "failed" });
}

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

function broadcastAuthStatus(status: AuthStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      send(window.webContents, ipcEvents.authStatusChanged, status);
    }
  }
}

function broadcastSnippetReplica(items: ReadonlyArray<ApiSnippet>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) send(window.webContents, ipcEvents.snippetReplicaChanged, items);
  }
}

function authStatusForSession(
  session: { accessToken: string; user: AuthStatus["user"] } | null,
): AuthStatus {
  if (session !== null) return authStatus(session);
  return activeSnippetAccountId !== undefined &&
    currentAuthStatus.user?.id === activeSnippetAccountId
    ? { accessToken: null, user: currentAuthStatus.user }
    : authStatus(null);
}

function activeSnippetAccount(): {
  readonly id: string;
  readonly accessToken: string | null;
} | null {
  if (activeSnippetAccountId === undefined) return null;
  return {
    id: activeSnippetAccountId,
    accessToken:
      currentAuthStatus.user?.id === activeSnippetAccountId ? currentAuthStatus.accessToken : null,
  };
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
        AuthService.use((auth) =>
          auth
            .handleCallbackUrl(rawUrl)
            .pipe(Effect.map((user) => (user === null ? null : authStatus(user)))),
        ),
      ),
    );

    if (!Result.isSuccess(result)) {
      handled = true;
      revealMainWindow();
      broadcastAuthError(authErrorMessage(result.failure, "Could not complete sign-in."));
      continue;
    }

    const status = result.success;
    if (status !== null) {
      handled = true;
      applyAuthStatus(status);
      broadcastAuthStatus(status);
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
    if (content.type !== "empty" && !window.isDestroyed()) {
      send(window.webContents, ipcEvents.clipboardPaste, content);
    }
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

    const storedAccount = await runEffect(
      ActiveSnippetAccount.use((account) => account.get).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not restore the active snippet account", { error }).pipe(
            Effect.as(null),
          ),
        ),
      ),
    );
    if (storedAccount !== null) {
      applyAuthStatus({ accessToken: null, user: storedAccount });
    }

    runtime.runFork(
      SnippetReplica.use((replica) =>
        replica.changes.pipe(
          Stream.runForEach(({ accountId, items }) =>
            Effect.sync(() => {
              if (accountId === activeSnippetAccountId) broadcastSnippetReplica(items);
            }),
          ),
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
      onAccountRefreshRequested: () => void refreshTrayAccountState(),
      onRendererLoaded: () => void refreshTrayAccountState(),
      onDropFiles: ({ files }) => {
        void Promise.all(
          files.map(async (path) => ({
            path,
            name: basename(path),
            size: (await stat(path)).size,
          })),
        ).then((files) => broadcastTrayDroppedItem({ type: "files", files }));
      },
      onDropText: ({ text }) => {
        if (text.trim()) broadcastTrayDroppedItem({ type: "text", text });
      },
      preloadPath: join(__dirname, "../preload/index.cjs"),
    });
    createWindow();
    void runAuth(
      AuthService.use((auth) => auth.getSession().pipe(Effect.map(authStatusForSession))),
      "Could not check session.",
    ).then(applyAuthStatus, () =>
      applyAuthStatus({ accessToken: null, user: currentAuthStatus.user }),
    );
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
  if (process.platform !== "darwin") app.quit();
});
