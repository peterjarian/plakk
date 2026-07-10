import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const electron = vi.hoisted(() => {
  class EventEmitter {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    once(event: string, listener: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter((entry) => entry !== wrapped),
        );
        listener(...args);
      };
      return this.on(event, wrapped);
    }
  }

  class WebContents extends EventEmitter {}

  class BrowserWindow extends EventEmitter {
    static instances: BrowserWindow[] = [];
    readonly webContents = new WebContents();
    readonly options: Record<string, unknown>;
    destroyed = false;
    visible = false;

    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      BrowserWindow.instances.push(this);
    }

    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    focus() {}
    hide() {
      this.visible = false;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    setAlwaysOnTop() {}
    setBounds() {}
    setVisibleOnAllWorkspaces() {}
    show() {
      this.visible = true;
    }
    showInactive() {
      this.visible = true;
    }
  }

  class Tray extends EventEmitter {
    static instances: Tray[] = [];
    destroyed = false;

    constructor() {
      super();
      Tray.instances.push(this);
    }

    destroy() {
      this.destroyed = true;
    }
    getBounds() {
      return { x: 20, y: 10, width: 16, height: 16 };
    }
    setToolTip() {}
  }

  return { BrowserWindow, Tray };
});

vi.mock("electron", () => ({
  app: { name: "Plakk" },
  BrowserWindow: electron.BrowserWindow,
  nativeImage: {
    createFromPath: () => ({
      resize() {
        return this;
      },
      setTemplateImage() {},
    }),
  },
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
  },
  Tray: electron.Tray,
}));

import { createTrayWindowController } from "./trayWindow.ts";

describe("tray window lifecycle", () => {
  beforeEach(() => {
    electron.BrowserWindow.instances.length = 0;
    electron.Tray.instances.length = 0;
  });

  afterEach(() => vi.useRealTimers());

  it("preloads hidden and waits for renderer and account readiness before showing", () => {
    const loadTrayRenderer = vi.fn();
    const controller = createTrayWindowController({
      guardExternalWindows: vi.fn(),
      loadTrayRenderer,
      preloadPath: "/preload.cjs",
    });

    controller.setup();
    const window = electron.BrowserWindow.instances[0]!;
    expect(electron.Tray.instances).toHaveLength(1);
    expect(electron.BrowserWindow.instances).toHaveLength(1);
    expect(window.options.show).toBe(false);
    expect(loadTrayRenderer).toHaveBeenCalledOnce();

    controller.show();
    expect(window.visible).toBe(false);
    window.webContents.emit("did-finish-load");
    expect(window.visible).toBe(false);
    controller.setAccountState(true, false);
    expect(window.visible).toBe(true);
  });

  it("gates native drops and destroys all tray ownership on sign-out", () => {
    const onDropFiles = vi.fn();
    const controller = createTrayWindowController({
      guardExternalWindows: vi.fn(),
      loadTrayRenderer: vi.fn(),
      onDropFiles,
      preloadPath: "/preload.cjs",
    });

    controller.setup();
    const tray = electron.Tray.instances[0]!;
    tray.emit("drop-files", {}, ["blocked.txt"]);
    expect(onDropFiles).not.toHaveBeenCalled();

    controller.setAccountState(true, true);
    electron.BrowserWindow.instances[0]!.webContents.emit("did-finish-load");
    controller.show();
    electron.BrowserWindow.instances[0]!.hide();
    tray.emit("drag-enter");
    tray.emit("drop-files", {}, ["ready.txt"]);
    expect(onDropFiles).toHaveBeenCalledWith(expect.objectContaining({ files: ["ready.txt"] }));

    controller.disable();
    expect(tray.destroyed).toBe(true);
    expect(electron.BrowserWindow.instances[0]!.destroyed).toBe(true);
    expect(controller.isIngestionEnabled()).toBe(false);
  });

  it("fails closed and refreshes before revealing stale content", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onAccountRefreshRequested = vi.fn();
    const controller = createTrayWindowController({
      guardExternalWindows: vi.fn(),
      loadTrayRenderer: vi.fn(),
      onAccountRefreshRequested,
      preloadPath: "/preload.cjs",
    });

    controller.setup();
    const tray = electron.Tray.instances[0]!;
    const window = electron.BrowserWindow.instances[0]!;
    window.webContents.emit("did-finish-load");
    controller.setAccountState(true, true);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    tray.emit("click", {}, tray.getBounds());
    expect(onAccountRefreshRequested).toHaveBeenCalledOnce();
    expect(window.visible).toBe(false);
    expect(controller.isIngestionEnabled()).toBe(false);

    controller.setAccountState(true, true);
    expect(window.visible).toBe(true);
  });
});
