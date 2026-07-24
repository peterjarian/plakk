import { join } from "node:path";
import { app, BrowserWindow, nativeImage, screen, Tray } from "electron";
import { getAnchoredWindowBounds } from "./position.ts";
import type { Rectangle } from "electron";

const trayWindowSize = { width: 360, height: 172 };
const accountStateMaxAgeMs = 5 * 60 * 1000;

type TrayNativeEvent = {
  bounds: Rectangle;
};

type TrayWindowControllerOptions = {
  getBackgroundColor: () => string;
  guardExternalWindows: (window: BrowserWindow) => void;
  loadTrayRenderer: (window: BrowserWindow) => void | Promise<void>;
  onAccountRefreshRequested?: () => void;
  onRendererLoaded?: () => void;
  onDragEnd?: (event: TrayNativeEvent) => void;
  onDragEnter?: (event: TrayNativeEvent) => void;
  onDragLeave?: (event: TrayNativeEvent) => void;
  onDropFiles?: (event: TrayNativeEvent & { files: string[] }) => void;
  onDropText?: (event: TrayNativeEvent & { text: string }) => void;
  preloadPath: string;
};

export function createTrayWindowController({
  getBackgroundColor,
  guardExternalWindows,
  loadTrayRenderer,
  onAccountRefreshRequested,
  onRendererLoaded,
  onDragEnd,
  onDragEnter,
  onDragLeave,
  onDropFiles,
  onDropText,
  preloadPath,
}: TrayWindowControllerOptions) {
  let tray: Tray | undefined;
  let window: BrowserWindow | undefined;
  let accountStateResolved = false;
  let accountStateUpdatedAt = 0;
  let ingestionEnabled = false;
  let hasBeenShown = false;
  let rendererLoaded = false;
  let freshnessTimer: ReturnType<typeof setTimeout> | undefined;
  let showWhenReady: { bounds?: Rectangle; focus: boolean } | undefined;
  let lastBlurHideAt = 0;

  function createTrayIcon() {
    const image = nativeImage.createFromPath(join(__dirname, "../../resources/icon.png")).resize({
      width: 16,
      height: 16,
    });
    image.setTemplateImage(process.platform === "darwin");

    tray = new Tray(image);
    tray.setToolTip(app.name);
    tray.on("click", (_event, bounds) => {
      toggleWindow(bounds);
    });
    tray.on("drag-enter", () => {
      if (!accountStateIsCurrent()) {
        requestAccountRefresh();
        showWindow(getTrayBounds());
        return;
      }
      if (!canIngest()) return;
      const bounds = getTrayBounds();
      showWindow(bounds);
      onDragEnter?.({ bounds });
    });
    tray.on("drag-leave", () => {
      if (canIngest()) onDragLeave?.({ bounds: getTrayBounds() });
    });
    tray.on("drag-end", () => {
      if (canIngest()) onDragEnd?.({ bounds: getTrayBounds() });
    });
    tray.on("drop-files", (_event, files) => {
      if (!canIngest()) return;
      const bounds = getTrayBounds();
      showWindow(bounds);
      onDropFiles?.({ bounds, files });
    });
    tray.on("drop-text", (_event, text) => {
      if (!canIngest()) return;
      const bounds = getTrayBounds();
      showWindow(bounds);
      onDropText?.({ bounds, text });
    });
  }

  function createWindow() {
    window = new BrowserWindow({
      ...trayWindowSize,
      backgroundColor: getBackgroundColor(),
      show: false,
      frame: false,
      resizable: false,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: "Plakk Tray",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    keepLayered(window);

    window.on("blur", () => {
      hideWindow();
    });

    window.once("closed", () => {
      window = undefined;
      rendererLoaded = false;
    });

    window.webContents.once("did-finish-load", () => {
      rendererLoaded = true;
      onRendererLoaded?.();
      revealWhenReady();
    });

    guardExternalWindows(window);
    void Promise.resolve(loadTrayRenderer(window)).catch((error: unknown) => {
      console.error("Failed to load tray renderer", error);
    });
  }

  function toggleWindow(activationBounds?: Rectangle) {
    if (Date.now() - lastBlurHideAt < 160) return;
    if (window === undefined || window.isDestroyed()) createWindow();
    if (window === undefined) return;

    if (window.isVisible()) {
      hideWindow();
      return;
    }

    if (hasBeenShown || !accountStateIsCurrent()) requestAccountRefresh();

    showWindow(activationBounds);
  }

  function showWindow(activationBounds?: Rectangle, focus = true) {
    if (window === undefined || window.isDestroyed()) createWindow();
    if (window === undefined) return;

    if (!rendererLoaded || !accountStateResolved) {
      showWhenReady = {
        ...(activationBounds === undefined ? {} : { bounds: activationBounds }),
        focus,
      };
      return;
    }

    const bounds = getTrayBounds(activationBounds);
    const display = screen.getDisplayMatching(bounds);
    window.setBounds(getAnchoredWindowBounds(trayWindowSize, bounds, display.workArea));

    keepLayered(window);

    if (focus) {
      window.show();
      window.focus();
      hasBeenShown = true;
      return;
    }

    window.showInactive();
    hasBeenShown = true;
  }

  function hideWindow() {
    lastBlurHideAt = Date.now();
    window?.hide();
  }

  function revealWhenReady() {
    if (!rendererLoaded || !accountStateResolved || showWhenReady === undefined) return;
    const pending = showWhenReady;
    showWhenReady = undefined;
    showWindow(pending.bounds, pending.focus);
  }

  function disable() {
    ingestionEnabled = false;
    accountStateResolved = false;
    accountStateUpdatedAt = 0;
    rendererLoaded = false;
    hasBeenShown = false;
    showWhenReady = undefined;
    if (freshnessTimer !== undefined) clearTimeout(freshnessTimer);
    freshnessTimer = undefined;
    window?.destroy();
    window = undefined;
    tray?.destroy();
    tray = undefined;
  }

  function accountStateIsCurrent() {
    return accountStateResolved && Date.now() - accountStateUpdatedAt <= accountStateMaxAgeMs;
  }

  function requestAccountRefresh() {
    accountStateResolved = false;
    ingestionEnabled = false;
    onAccountRefreshRequested?.();
  }

  function canIngest() {
    return ingestionEnabled && accountStateIsCurrent();
  }

  function keepLayered(target: BrowserWindow) {
    target.setAlwaysOnTop(true, "pop-up-menu");
    if (process.platform === "darwin") {
      target.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }
  }

  function getTrayBounds(activationBounds?: Rectangle): Rectangle {
    if (hasSize(activationBounds)) return activationBounds;

    const bounds = tray?.getBounds();
    if (hasSize(bounds)) return bounds;

    const { workArea } = screen.getPrimaryDisplay();
    return { x: workArea.x + workArea.width, y: workArea.y, width: 0, height: 0 };
  }

  function hasSize(bounds: Rectangle | undefined): bounds is Rectangle {
    return bounds !== undefined && bounds.width > 0 && bounds.height > 0;
  }

  return {
    disable,
    isIngestionEnabled: canIngest,
    ownsWebContents: (contents: Electron.WebContents) => window?.webContents === contents,
    setAccountState(resolved: boolean, canIngest: boolean) {
      accountStateResolved = resolved;
      if (freshnessTimer !== undefined) clearTimeout(freshnessTimer);
      freshnessTimer = undefined;
      if (resolved) {
        accountStateUpdatedAt = Date.now();
        freshnessTimer = setTimeout(() => {
          ingestionEnabled = false;
          if (window?.isVisible() === true) {
            requestAccountRefresh();
          }
        }, accountStateMaxAgeMs);
      }
      ingestionEnabled = resolved && canIngest;
      revealWhenReady();
    },
    show: showWindow,
    setup() {
      if (tray !== undefined) return;
      createTrayIcon();
      createWindow();
    },
  };
}
