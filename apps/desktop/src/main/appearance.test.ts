import { describe, expect, it, vi } from "vite-plus/test";

import type { AppearancePreference } from "../ipc/contracts.ts";
import { createAppearanceController } from "./appearance.ts";

type Listener = () => void;

function makeNativeTheme(initialDark: boolean) {
  const listeners = new Set<Listener>();
  let shouldUseDarkColors = initialDark;
  let themeSource: AppearancePreference = "system";

  return {
    get shouldUseDarkColors() {
      return shouldUseDarkColors;
    },
    get themeSource() {
      return themeSource;
    },
    set themeSource(value: AppearancePreference) {
      themeSource = value;
      shouldUseDarkColors = value === "dark" || (value === "system" && shouldUseDarkColors);
    },
    on: (_event: "updated", listener: Listener) => {
      listeners.add(listener);
    },
    useSystemDarkColors(value: boolean) {
      if (themeSource !== "system") return;
      shouldUseDarkColors = value;
      for (const listener of listeners) listener();
    },
  };
}

function makeWindow() {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    setBackgroundColor: vi.fn(),
    webContents: {},
  };
}

describe("desktop appearance", () => {
  it("starts in System and exposes the effective appearance for initial windows", () => {
    const nativeTheme = makeNativeTheme(true);
    const controller = createAppearanceController({
      getWindows: () => [],
      initialPreference: "system",
      nativeTheme,
      sendState: vi.fn(),
    });

    expect(nativeTheme.themeSource).toBe("system");
    expect(controller.getState()).toEqual({ preference: "system", effective: "dark" });
    expect(controller.getBackgroundColor()).toBe("#0a0a0a");
    expect(controller.addToRendererUrl(new URL("plakk-app://renderer/index.html")).search).toBe(
      "?appearance=system&effectiveAppearance=dark",
    );
  });

  it("applies Light and Dark to every desktop window regardless of the system", () => {
    const nativeTheme = makeNativeTheme(true);
    const main = makeWindow();
    const tray = makeWindow();
    const sendState = vi.fn();
    const controller = createAppearanceController({
      getWindows: () => [main, tray],
      initialPreference: "system",
      nativeTheme,
      sendState,
    });

    controller.setPreference("light");
    expect(nativeTheme.themeSource).toBe("light");
    expect(controller.getState()).toEqual({ preference: "light", effective: "light" });
    expect(main.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    expect(tray.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");

    controller.setPreference("dark");
    expect(nativeTheme.themeSource).toBe("dark");
    expect(controller.getState()).toEqual({ preference: "dark", effective: "dark" });
    expect(main.setBackgroundColor).toHaveBeenLastCalledWith("#0a0a0a");
    expect(tray.setBackgroundColor).toHaveBeenLastCalledWith("#0a0a0a");
    expect(sendState).toHaveBeenLastCalledWith(tray.webContents, {
      preference: "dark",
      effective: "dark",
    });
  });

  it("updates main and Tray together when System appearance changes live", () => {
    const nativeTheme = makeNativeTheme(false);
    const main = makeWindow();
    const tray = makeWindow();
    const sendState = vi.fn();
    const controller = createAppearanceController({
      getWindows: () => [main, tray],
      initialPreference: "system",
      nativeTheme,
      sendState,
    });

    nativeTheme.useSystemDarkColors(true);

    expect(controller.getState()).toEqual({ preference: "system", effective: "dark" });
    expect(main.setBackgroundColor).toHaveBeenLastCalledWith("#0a0a0a");
    expect(tray.setBackgroundColor).toHaveBeenLastCalledWith("#0a0a0a");
    expect(sendState).toHaveBeenCalledTimes(2);
  });
});
