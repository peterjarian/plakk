import { join } from "node:path";
import { app, BrowserWindow, nativeImage, screen, Tray } from "electron";
import { getAnchoredWindowBounds } from "./trayPosition.ts";
import type { Rectangle } from "electron";

const trayWindowSize = { width: 360, height: 480 };

type TrayWindowControllerOptions = {
  guardExternalWindows: (window: BrowserWindow) => void;
  loadTrayRenderer: (window: BrowserWindow) => void | Promise<void>;
  preloadPath: string;
};

export function createTrayWindowController({
  guardExternalWindows,
  loadTrayRenderer,
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
    tray.on("click", toggleWindow);
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

    window.on("blur", () => {
      lastBlurHideAt = Date.now();
      window?.hide();
    });

    window.once("closed", () => {
      window = undefined;
    });

    guardExternalWindows(window);
    void loadTrayRenderer(window);
  }

  function toggleWindow() {
    if (Date.now() - lastBlurHideAt < 160) return;
    if (window === undefined || window.isDestroyed()) createWindow();
    if (window === undefined) return;

    if (window.isVisible()) {
      window.hide();
      return;
    }

    const bounds = getTrayBounds();
    const display = screen.getDisplayMatching(bounds);
    window.setBounds(getAnchoredWindowBounds(trayWindowSize, bounds, display.workArea));
    window.show();
    window.focus();
  }

  function getTrayBounds(): Rectangle {
    const bounds = tray?.getBounds();
    if (bounds !== undefined && bounds.width > 0 && bounds.height > 0) return bounds;

    const { workArea } = screen.getPrimaryDisplay();
    return { x: workArea.x + workArea.width, y: workArea.y, width: 0, height: 0 };
  }

  return {
    setup() {
      if (tray !== undefined) return;
      createTrayIcon();
    },
  };
}
