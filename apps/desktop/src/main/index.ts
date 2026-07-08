import "dotenv/config";

import { join, resolve } from "node:path";
import { isHttpUrl } from "@plakk/shared";
import { PlakkApi } from "@plakk/shared/PlakkApi";
import { app, BrowserWindow, Menu, shell } from "electron";
import { Config, Effect, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { AuthStatus } from "../auth.ts";
import { handle, send } from "../ipc/main.ts";
import { ipcEvents, ipcMethods } from "../ipc/contracts.ts";
import type { UserConfigPatch } from "../userConfig.ts";
import { AuthService } from "./auth/AuthService.ts";
import { readClipboard } from "./clipboard.ts";
import { UserConfigStore } from "./UserConfigStore.ts";
import { runEffect } from "./runtime.ts";

handle(ipcMethods.openExternal, (url) => {
  if (!isHttpUrl(url)) return;
  return shell.openExternal(url);
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

function authStatus(user: AuthStatus["user"]): AuthStatus {
  return {
    user,
  };
}

handle(ipcMethods.authGet, () =>
  runAuth(
    AuthService.use((auth) => auth.getSession().pipe(Effect.map(authStatus))),
    "Could not check session.",
  ),
);

handle(ipcMethods.authSignIn, async () => {
  const redirectUrl = await runAuth(
    Config.url("WORKOS_REDIRECT_URI"),
    "Desktop auth is not configured.",
  );
  registerAuthCallbackProtocol(redirectUrl);

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
  broadcastAuthStatus(authStatus(null));
});

handle(ipcMethods.userConfigGet, () => runEffect(UserConfigStore.use((store) => store.get)));

handle(ipcMethods.userConfigSet, (patch: UserConfigPatch) =>
  runEffect(UserConfigStore.use((store) => store.set(patch))),
);

handle(ipcMethods.userConfigReset, () => runEffect(UserConfigStore.use((store) => store.reset)));

type RendererView = "home" | "settings" | "welcome";

let mainWindow: BrowserWindow | undefined;
let isQuitting = false;

app.setName(app.isPackaged ? "Plakk" : "Plakk (Dev)");

const pendingOpenUrls = new Set<string>();
const DEFAULT_PLAKK_API_RPC_URL = "http://localhost:3000/api/rpc";
type PlakkApiClient = RpcClient.FromGroup<typeof PlakkApi, RpcClientError>;

function callPlakkApi<A>(useClient: (client: PlakkApiClient) => Effect.Effect<A, unknown>) {
  return Effect.gen(function* () {
    const accessToken = yield* AuthService.use((auth) => auth.getAccessToken());
    if (accessToken === null) {
      return yield* Effect.fail(new Error("Sign in to continue."));
    }

    const url = yield* Config.string("PLAKK_API_RPC_URL").pipe(
      Effect.orElseSucceed(() => DEFAULT_PLAKK_API_RPC_URL),
    );
    const program = Effect.gen(function* () {
      const client = yield* RpcClient.make(PlakkApi);
      return yield* useClient(client).pipe(
        RpcClient.withHeaders({ authorization: `Bearer ${accessToken}` }),
      );
    });

    return yield* program.pipe(
      Effect.provide(RpcClient.layerProtocolHttp({ url })),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(RpcSerialization.layerNdjson),
      Effect.scoped,
    );
  });
}

async function runPlakkApi<A>(
  effect: (client: PlakkApiClient) => Effect.Effect<A, unknown>,
  fallback: string,
): Promise<A> {
  const result = await runEffect(Effect.result(callPlakkApi(effect)));

  if (!Result.isSuccess(result)) {
    throw new Error(authErrorMessage(result.failure, fallback));
  }

  return result.success;
}

handle(ipcMethods.plakkApiGetAccountStatus, () =>
  runPlakkApi((client) => client.GetAccountStatus(), "Could not load account status."),
);

handle(ipcMethods.plakkApiGetPipeConnectionStatus, (payload) =>
  runPlakkApi(
    (client) => client.GetPipeConnectionStatus(payload),
    "Could not load storage connection status.",
  ),
);

handle(ipcMethods.plakkApiListSnippets, (payload) =>
  runPlakkApi((client) => client.ListSnippets(payload), "Could not load snippets."),
);

handle(ipcMethods.plakkApiCreateStoredSnippet, (payload) =>
  runPlakkApi((client) => client.CreateStoredSnippet(payload), "Could not create stored snippet."),
);

handle(ipcMethods.plakkApiCreateTextSnippet, (payload) =>
  runPlakkApi((client) => client.CreateTextSnippet(payload), "Could not create text snippet."),
);

handle(ipcMethods.plakkApiPrepareStoredSnippetUpload, (payload) =>
  runPlakkApi(
    (client) => client.PrepareStoredSnippetUpload(payload),
    "Could not prepare stored snippet upload.",
  ),
);

handle(ipcMethods.plakkApiUpdateStoredSnippetUploadStatus, (payload) =>
  runPlakkApi(
    (client) => client.UpdateStoredSnippetUploadStatus(payload),
    "Could not update upload status.",
  ),
);

handle(ipcMethods.plakkApiDeleteSnippet, (payload) =>
  runPlakkApi((client) => client.DeleteSnippet(payload), "Could not delete snippet."),
);

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

  return window.loadFile(
    join(__dirname, "../renderer/index.html"),
    view === undefined ? undefined : { query: { view } },
  );
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
}

function isSameRendererNavigation(current: string, next: string) {
  try {
    const currentUrl = new URL(current);
    const nextUrl = new URL(next);

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
    if (view !== undefined) void loadRenderer(mainWindow, view);
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

function registerAuthCallbackProtocol(redirectUrl: URL): void {
  redirectUrl.protocol = app.isPackaged ? "plakk:" : "plakk-dev:";

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

function broadcastAuthError(message: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      send(window.webContents, ipcEvents.authError, { message });
    }
  }
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
      broadcastAuthStatus(status);
      revealMainWindow();
    }
  }

  return handled;
}

function pasteIntoFocusedWindow(): void {
  const window = BrowserWindow.getFocusedWindow();
  if (window === null) return;

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

  void app.whenReady().then(() => {
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
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );

    createWindow();
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
