import { join } from "node:path";
import { app, BrowserWindow, nativeImage, screen, Tray } from "electron";
import { getAnchoredWindowBounds } from "./trayPosition.ts";
import type { Rectangle } from "electron";

const trayWindowSize = { width: 360, height: 480 };

type TrayNativeEvent = {
  bounds: Rectangle;
};

type TrayWindowControllerOptions = {
  guardExternalWindows: (window: BrowserWindow) => void;
  loadTrayRenderer: (window: BrowserWindow) => void | Promise<void>;
  onDragEnd?: (event: TrayNativeEvent) => void;
  onDragEnter?: (event: TrayNativeEvent) => void;
  onDragLeave?: (event: TrayNativeEvent) => void;
  onDropFiles?: (event: TrayNativeEvent & { files: string[] }) => void;
  onDropText?: (event: TrayNativeEvent & { text: string }) => void;
  preloadPath: string;
};

export function createTrayWindowController({
  guardExternalWindows,
  loadTrayRenderer,
  onDragEnd,
  onDragEnter,
  onDragLeave,
  onDropFiles,
  onDropText,
  preloadPath,
}: TrayWindowControllerOptions) {
  let tray: Tray | undefined;
  let window: BrowserWindow | undefined;
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
      const bounds = getTrayBounds();
      showWindow(bounds);
      onDragEnter?.({ bounds });
    });
    tray.on("drag-leave", () => onDragLeave?.({ bounds: getTrayBounds() }));
    tray.on("drag-end", () => onDragEnd?.({ bounds: getTrayBounds() }));
    tray.on("drop-files", (_event, files) => {
      const bounds = getTrayBounds();
      showWindow(bounds);
      onDropFiles?.({ bounds, files });
    });
    tray.on("drop-text", (_event, text) => {
      const bounds = getTrayBounds();
      showWindow(bounds);
      onDropText?.({ bounds, text });
    });
  }

  function createWindow() {
    window = new BrowserWindow({
      ...trayWindowSize,
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
    });

    guardExternalWindows(window);
    void loadTrayRenderer(window);
  }

  function toggleWindow(activationBounds?: Rectangle) {
    if (Date.now() - lastBlurHideAt < 160) return;
    if (window === undefined || window.isDestroyed()) createWindow();
    if (window === undefined) return;

    if (window.isVisible()) {
      hideWindow();
      return;
    }

    showWindow(activationBounds);
  }

  function showWindow(activationBounds?: Rectangle, focus = true) {
    if (window === undefined || window.isDestroyed()) createWindow();
    if (window === undefined) return;

    const bounds = getTrayBounds(activationBounds);
    const display = screen.getDisplayMatching(bounds);
    window.setBounds(getAnchoredWindowBounds(trayWindowSize, bounds, display.workArea));

    keepLayered(window);

    if (focus) {
      window.show();
      window.focus();
      return;
    }

    window.showInactive();
  }

  function hideWindow() {
    lastBlurHideAt = Date.now();
    window?.hide();
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
    show: showWindow,
    setup() {
      if (tray !== undefined) return;
      createTrayIcon();
    },
  };
}
