import "dotenv/config";

import { basename, join, resolve, sep } from "node:path";
import { rm, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { deriveSnippetPresentation, isHttpUrl } from "@plakk/shared";
import { accountCanSync } from "@plakk/shared/PlakkApi";
import { SnippetReplica, runSnippetReplicaSync } from "@plakk/shared/SnippetReplica";
import { app, BrowserWindow, dialog, Menu, net, protocol, shell } from "electron";
import { Effect, Result, Stream } from "effect";
import * as Fiber from "effect/Fiber";
import type {
  AuthStatus,
  DesktopSnippet,
  TrayAccountState,
  TrayDroppedItem,
} from "../ipc/contracts.ts";
import { ipcEvents, ipcMethods } from "../ipc/contracts.ts";
import { IpcHandlerError, makeHandle, send } from "../ipc/main.ts";
import { getAccountStatus, isUnauthenticatedAccountError } from "./accountStatus.ts";
import { AuthService, AuthServiceError } from "./auth/AuthService.ts";
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
import { ActiveSnippetAccount, getManagedSnippetBytes, getReplicaItems } from "./snippetReplica.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";

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

handle(ipcMethods.snippetIngest, (payload, event) => {
  const cleanup = Effect.gen(function* () {
    if (!("filePath" in payload) || !consumeTemporaryClipboardFile(payload.filePath)) return;
    yield* Effect.tryPromise(() => rm(payload.filePath, { force: true })).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not remove a temporary clipboard file", { cause }),
      ),
    );
  });

  return Effect.gen(function* () {
    if (
      trayWindowController?.ownsWebContents(event.sender) === true &&
      !trayWindowController.isIngestionEnabled()
    ) {
      return { status: "FAILED", message: "Adding is paused until the account is ready." } as const;
    }
    const account = activeSnippetAccount();
    if (account === null) {
      return { status: "FAILED", message: "Sign in before adding snippets." } as const;
    }
    const engine = yield* SnippetUploadEngine;
    return yield* engine.ingest(account.id, payload).pipe(
      Effect.as({ status: "ENQUEUED" } as const),
      Effect.catchTag("SnippetUploadEngineError", (error) =>
        Effect.succeed({ status: "FAILED", message: error.reason } as const),
      ),
    );
  }).pipe(Effect.ensuring(cleanup));
});

handle(ipcMethods.snippetDiscard, (id) => {
  const account = activeSnippetAccount();
  return account === null
    ? Effect.void
    : SnippetUploadEngine.use((engine) => engine.discard(account.id, id)).pipe(
        asIpcFailure("Could not discard this local snippet."),
      );
});

handle(ipcMethods.snippetCancel, (id) => {
  const account = activeSnippetAccount();
  return account === null
    ? Effect.void
    : SnippetUploadEngine.use((engine) => engine.cancel(account, id)).pipe(
        asIpcFailure("Could not stop this upload."),
      );
});

handle(ipcMethods.snippetRetry, (id) => {
  const account = activeSnippetAccount();
  return account === null
    ? Effect.void
    : SnippetUploadEngine.use((engine) => engine.retry(account, id)).pipe(
        asIpcFailure("Could not retry this upload."),
      );
});

handle(ipcMethods.snippetDelete, (id) => {
  const account = activeSnippetAccount();
  return account === null
    ? Effect.void
    : SnippetUploadEngine.use((engine) => engine.delete(account, id)).pipe(
        asIpcFailure("Could not delete this snippet."),
      );
});

const findSnippet = Effect.fn("DesktopSnippetProjection.find")(function* (id: string) {
  const account = activeSnippetAccount();
  if (account === null) {
    return yield* new IpcHandlerError({
      cause: null,
      message: "Sign in to load stored snippets.",
    });
  }
  const snippets = yield* getProjectedSnippets(account.id).pipe(
    asIpcFailure("Could not load your snippets."),
  );
  const snippet = snippets.find((item) => item.id === id);
  if (snippet === undefined) {
    return yield* new IpcHandlerError({ cause: null, message: "Snippet was not found." });
  }
  return { account, snippet };
});

handle(ipcMethods.snippetCopy, (id) =>
  Effect.gen(function* () {
    const { account, snippet } = yield* findSnippet(id);
    const { bytes } = yield* Effect.scoped(getManagedSnippetBytes(account, id, snippet)).pipe(
      asIpcFailure("Could not load this snippet."),
    );
    const presentation = deriveSnippetPresentation({ fileName: snippet.fileName, content: bytes });
    if (presentation.type === "text" || presentation.type === "hyperlink") {
      return yield* writeClipboard({
        type: "text",
        text: new TextDecoder().decode(bytes),
      }).pipe(asIpcFailure("Could not copy this snippet."));
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

handle(ipcMethods.snippetList, () =>
  activeSnippetAccountId === undefined
    ? Effect.succeed([])
    : getProjectedSnippets(activeSnippetAccountId).pipe(
        asIpcFailure("Could not load your snippets."),
      ),
);

handle(ipcMethods.clipboardRead, () =>
  readClipboard().pipe(asIpcFailure("Could not read the clipboard.")),
);

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
      (path) =>
        Effect.tryPromise({
          try: () => stat(path),
          catch: (cause) =>
            new IpcHandlerError({ cause, message: "Could not read the selected file." }),
        }).pipe(Effect.map((file) => ({ path, name: basename(path), size: file.size }))),
      { concurrency: "unbounded" },
    );
  }),
);

function authStatus(session: { accessToken: string; user: AuthStatus["user"] } | null): AuthStatus {
  return {
    accessToken: session?.accessToken ?? null,
    user: session?.user ?? null,
  };
}

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

handle(ipcMethods.authGet, () =>
  withAuthIpcError(
    AuthService.use((auth) => auth.getSession().pipe(Effect.map(authStatusForSession))),
    "Could not check session.",
  ).pipe(
    Effect.tap((status) => Effect.sync(() => applyAuthStatus(status))),
    Effect.catchTag("IpcHandlerError", (error) => {
      const paused = { accessToken: null, user: currentAuthStatus.user } satisfies AuthStatus;
      return Effect.sync(() => applyAuthStatus(paused)).pipe(
        Effect.andThen(paused.user === null ? Effect.fail(error) : Effect.succeed(paused)),
      );
    }),
  ),
);

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
  Effect.gen(function* () {
    yield* withAuthIpcError(
      AuthService.use((auth) => auth.signOut()),
      "Could not sign out.",
    );
    if (snippetAccountPersistenceFiber !== undefined) {
      yield* Fiber.interrupt(snippetAccountPersistenceFiber);
      snippetAccountPersistenceFiber = undefined;
    }
    yield* ActiveSnippetAccount.use((account) => account.set(null)).pipe(
      asIpcFailure("Could not clear the local account."),
    );
    activeSnippetAccountId = undefined;
    const status = authStatus(null);
    yield* Effect.sync(() => {
      applyAuthStatus(status);
      broadcastSnippetReplica([]);
      broadcastAuthStatus(status);
    });
  }),
);

handle(ipcMethods.userConfigGet, () =>
  UserConfigStore.use((store) => store.get).pipe(
    asIpcFailure("Could not load desktop preferences."),
  ),
);

handle(ipcMethods.userConfigSet, (patch) =>
  UserConfigStore.use((store) => store.set(patch)).pipe(
    asIpcFailure("Could not save desktop preferences."),
  ),
);

handle(ipcMethods.userConfigReset, () =>
  UserConfigStore.use((store) => store.reset).pipe(
    asIpcFailure("Could not reset desktop preferences."),
  ),
);

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
  Effect.succeed(
    trayWindowController?.ownsWebContents(event.sender) === true
      ? currentTrayAccountState
      : ({ kind: "failed" } satisfies TrayAccountState),
  ),
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
    runtime.runFork(SnippetUploadEngine.use((engine) => engine.pause));
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
  const accessToken = status.accessToken;
  const user = status.user;

  const generation = ++trayRefreshGeneration;
  trayWindowController.setAccountState(false, false);
  sendTrayAccountState({ kind: "loading" });

  const result = await runEffect(Effect.result(Effect.scoped(getAccountStatus(accessToken))));
  if (generation !== trayRefreshGeneration || currentAuthStatus.accessToken !== accessToken) return;

  if (Result.isSuccess(result)) {
    const account = result.success;
    trayWindowController.setAccountState(true, accountCanSync(account));
    sendTrayAccountState({ kind: "resolved", account });
    const uploadAccount = accountCanSync(account)
      ? SnippetUploadEngine.use((engine) => engine.resume({ id: user.id, accessToken }))
      : SnippetUploadEngine.use((engine) => engine.pause);
    void runEffect(
      uploadAccount.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not resume queued uploads", { cause }).pipe(
            Effect.andThen(
              Effect.sync(() => broadcastAuthError("Could not resume queued uploads.")),
            ),
          ),
        ),
      ),
    );
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

const getProjectedSnippets = Effect.fn("DesktopSnippetProjection.list")(function* (
  accountId: string,
) {
  const replicaItems = yield* getReplicaItems(accountId);
  const engine = yield* SnippetUploadEngine;
  yield* engine.reconcile(accountId, replicaItems);
  return yield* engine.project(accountId, replicaItems);
});

function broadcastSnippetReplica(items: ReadonlyArray<DesktopSnippet>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) send(window.webContents, ipcEvents.snippetReplicaChanged, items);
  }
}

const refreshSnippetProjection = Effect.fn("DesktopSnippetProjection.refresh")(function* (
  accountId: string,
) {
  const replicaItems = yield* getReplicaItems(accountId);
  const engine = yield* SnippetUploadEngine;
  yield* engine.reconcile(accountId, replicaItems);
  const items = yield* engine.project(accountId, replicaItems);
  yield* Effect.sync(() => {
    if (accountId === activeSnippetAccountId) broadcastSnippetReplica(items);
  });
});

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
      broadcastAuthError(authFailureMessage(result.failure, "Could not complete sign-in."));
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
      Effect.gen(function* () {
        const replica = yield* SnippetReplica;
        const uploads = yield* SnippetUploadEngine;
        const refresh = (accountId: string) =>
          refreshSnippetProjection(accountId).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Could not refresh the desktop snippet projection", { cause }),
            ),
          );
        yield* Effect.all(
          [
            replica.changes.pipe(Stream.runForEach(({ accountId }) => refresh(accountId))),
            uploads.changes.pipe(Stream.runForEach(refresh)),
          ],
          { concurrency: "unbounded", discard: true },
        );
      }),
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
    void runEffect(
      AuthService.use((auth) => auth.getSession().pipe(Effect.map(authStatusForSession))).pipe(
        Effect.match({
          onFailure: () => applyAuthStatus({ accessToken: null, user: currentAuthStatus.user }),
          onSuccess: applyAuthStatus,
        }),
      ),
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
