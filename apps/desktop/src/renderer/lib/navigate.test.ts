import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

describe("desktop navigation", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { search: "?view=home" },
    });
  });

  it("switches Home and Settings in-session and keeps the same subscribers", async () => {
    const replaceState = vi.fn();
    Object.defineProperty(globalThis, "history", { configurable: true, value: { replaceState } });
    const navigation = await import("./navigate.ts");
    const listener = vi.fn();
    const unsubscribe = navigation.subscribeToDesktopView(listener);

    navigation.setDesktopView("settings");
    expect(navigation.getDesktopView()).toBe("settings");
    expect(listener).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(null, "", "?view=settings");

    navigation.setDesktopView("home");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
