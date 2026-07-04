import { join } from "node:path";
import { isHttpUrl } from "@plakk/shared";
import { app, BrowserWindow, Menu, shell } from "electron";
import { ipcEvents, ipcMethods, type UserConfigPatch } from "../ipc/contracts.js";
import { handle, send } from "../ipc/main.js";
import { readClipboard } from "./clipboard.js";
import { UserConfigStore } from "./UserConfigStore.js";
import { runEffect } from "./runtime.js";

handle(ipcMethods.openExternal, (url) => {
  if (!isHttpUrl(url)) return;
  return shell.openExternal(url);
});

handle(ipcMethods.userConfigGet, () => runEffect(UserConfigStore.use((store) => store.get)));

handle(ipcMethods.userConfigSet, (patch: UserConfigPatch) =>
  runEffect(UserConfigStore.use((store) => store.set(patch))),
);

handle(ipcMethods.userConfigReset, () => runEffect(UserConfigStore.use((store) => store.reset)));

type RendererView = "home" | "settings" | "welcome";

let settingsWindow: BrowserWindow | undefined;
let mainWindow: BrowserWindow | undefined;
let isQuitting = false;

app.setName(app.isPackaged ? "Plakk" : "Plakk (Dev)");

function loadRenderer(window: BrowserWindow, view: RendererView) {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    url.searchParams.set("view", view);
    return window.loadURL(url.toString());
  }

  return window.loadFile(join(__dirname, "../renderer/index.html"), { query: { view } });
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

const createWindow = (): void => {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
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

  void loadRenderer(mainWindow, "welcome");
};

function createSettingsWindow(): BrowserWindow {
  if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 460,
    height: 580,
    minWidth: 420,
    minHeight: 500,
    fullscreenable: false,
    maximizable: false,
    resizable: false,
    show: false,
    title: "Settings",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 14 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  settingsWindow.on("close", (event) => {
    if (isQuitting) return;

    event.preventDefault();
    settingsWindow?.hide();
  });

  settingsWindow.once("closed", () => {
    settingsWindow = undefined;
  });

  guardExternalWindows(settingsWindow);
  void loadRenderer(settingsWindow, "settings");

  return settingsWindow;
}

function openSettingsWindow(): void {
  const window = createSettingsWindow();
  window.show();
  window.focus();
}

handle(ipcMethods.openSettings, openSettingsWindow);

function pasteIntoFocusedWindow(): void {
  const window = BrowserWindow.getFocusedWindow();
  if (window === null) return;

  void runEffect(readClipboard()).then((content) => {
    if (content.type !== "empty" && !window.isDestroyed()) {
      send(window.webContents, ipcEvents.clipboardPaste, content);
    }
  });
}

void app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { label: "Settings", accelerator: "CommandOrControl+,", click: openSettingsWindow },
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
  createSettingsWindow();

  app.on("activate", () => {
    createWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
