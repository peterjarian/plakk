import { describe, expect, it, vi } from "vite-plus/test";
import {
  isReloadShortcut,
  reconcileTrayAuth,
  resolveDesktopUserDataPath,
  type DesktopAuthState,
} from "./lifecycle.ts";

const signedIn: DesktopAuthState = {
  user: {
    id: "user_1",
    email: "user@example.com",
    firstName: "Test",
    lastName: "User",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

describe("desktop lifecycle", () => {
  it("isolates explicitly configured validation profiles", () => {
    expect(resolveDesktopUserDataPath("/default/profile", undefined)).toBe("/default/profile");
    expect(resolveDesktopUserDataPath("/default/profile", "  ")).toBe("/default/profile");
    expect(resolveDesktopUserDataPath("/default/profile", "/profiles/origin")).toBe(
      "/profiles/origin",
    );
    expect(resolveDesktopUserDataPath("/default/profile", "/profiles/replica")).toBe(
      "/profiles/replica",
    );
  });

  it("blocks reload accelerators without blocking ordinary shortcuts", () => {
    expect(
      isReloadShortcut({ type: "keyDown", key: "r", meta: true, control: false }, "darwin"),
    ).toBe(true);
    expect(
      isReloadShortcut({ type: "keyDown", key: "R", meta: false, control: true }, "win32"),
    ).toBe(true);
    expect(isReloadShortcut({ type: "keyDown", key: "F5", meta: false, control: false })).toBe(
      true,
    );
    expect(
      isReloadShortcut({ type: "keyDown", key: "r", meta: false, control: false }, "darwin"),
    ).toBe(false);
    expect(
      isReloadShortcut({ type: "keyUp", key: "r", meta: true, control: false }, "darwin"),
    ).toBe(false);
  });

  it("keeps the tray for a known offline account and removes it on sign-out", () => {
    const controller = { setup: vi.fn(), disable: vi.fn() };

    reconcileTrayAuth({ user: null }, controller);
    expect(controller.disable).toHaveBeenCalledOnce();
    expect(controller.setup).not.toHaveBeenCalled();

    reconcileTrayAuth(signedIn, controller);
    expect(controller.setup).toHaveBeenCalledOnce();

    reconcileTrayAuth({ user: signedIn.user }, controller);
    expect(controller.setup).toHaveBeenCalledTimes(2);

    reconcileTrayAuth({ user: null }, controller);
    expect(controller.disable).toHaveBeenCalledTimes(2);
  });
});
