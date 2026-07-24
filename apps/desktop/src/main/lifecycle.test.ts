import { describe, expect, it, vi } from "vite-plus/test";
import {
  isReloadShortcut,
  reconcileTrayLifecycle,
  resolveDesktopUserDataPath,
  type DesktopTrayState,
} from "./lifecycle.ts";

const signedIn = {
  user: {
    id: "user_1",
    email: "user@example.com",
    firstName: "Test",
    lastName: "User",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  canIngest: true,
  toolbarWidgetEnabled: true,
} satisfies DesktopTrayState;

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

  it("creates the enabled tray only for a signed-in account and applies readiness", () => {
    const controller = { setup: vi.fn(), disable: vi.fn(), setAccountState: vi.fn() };

    reconcileTrayLifecycle({ ...signedIn, user: null }, controller);
    expect(controller.disable).toHaveBeenCalledOnce();
    expect(controller.setup).not.toHaveBeenCalled();
    expect(controller.setAccountState).not.toHaveBeenCalled();

    reconcileTrayLifecycle(signedIn, controller);
    expect(controller.setup).toHaveBeenCalledOnce();
    expect(controller.setAccountState).toHaveBeenLastCalledWith(true, true);

    reconcileTrayLifecycle({ ...signedIn, canIngest: false }, controller);
    expect(controller.setup).toHaveBeenCalledTimes(2);
    expect(controller.setAccountState).toHaveBeenLastCalledWith(true, false);
  });

  it("removes the tray when signed out or disabled without applying stale readiness", () => {
    const controller = { setup: vi.fn(), disable: vi.fn(), setAccountState: vi.fn() };

    reconcileTrayLifecycle({ ...signedIn, toolbarWidgetEnabled: false }, controller);
    reconcileTrayLifecycle({ ...signedIn, user: null }, controller);

    expect(controller.disable).toHaveBeenCalledTimes(2);
    expect(controller.setup).not.toHaveBeenCalled();
    expect(controller.setAccountState).not.toHaveBeenCalled();
  });
});
