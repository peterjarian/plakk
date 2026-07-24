import { describe, expect, it, vi } from "vite-plus/test";
import {
  createToolbarWidgetLifecycle,
  isReloadShortcut,
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

  it("restores the preference and applies live toggles to a signed-in account", () => {
    const controller = { setup: vi.fn(), disable: vi.fn(), setAccountState: vi.fn() };
    const lifecycle = createToolbarWidgetLifecycle(controller, false);

    lifecycle.applyAccountState(signedIn);
    expect(controller.disable).toHaveBeenCalledOnce();
    expect(controller.setup).not.toHaveBeenCalled();
    expect(controller.setAccountState).not.toHaveBeenCalled();

    lifecycle.applyToolbarWidgetPreference(true);
    expect(controller.setup).toHaveBeenCalledOnce();
    expect(controller.setAccountState).toHaveBeenLastCalledWith(true, true);

    lifecycle.applyAccountState({ ...signedIn, canIngest: false });
    expect(controller.setup).toHaveBeenCalledTimes(2);
    expect(controller.setAccountState).toHaveBeenLastCalledWith(true, false);

    lifecycle.applyToolbarWidgetPreference(false);
    expect(controller.disable).toHaveBeenCalledTimes(2);
  });

  it("removes the tray on sign-out and restores it after sign-in only while enabled", () => {
    const controller = { setup: vi.fn(), disable: vi.fn(), setAccountState: vi.fn() };
    const lifecycle = createToolbarWidgetLifecycle(controller, true);

    lifecycle.applyAccountState(signedIn);
    lifecycle.applyAccountState({ canIngest: false, user: null });
    lifecycle.applyToolbarWidgetPreference(false);
    lifecycle.applyAccountState(signedIn);

    expect(controller.disable).toHaveBeenCalledTimes(3);
    expect(controller.setup).toHaveBeenCalledOnce();
    expect(controller.setAccountState).toHaveBeenCalledOnce();

    lifecycle.applyToolbarWidgetPreference(true);
    expect(controller.setup).toHaveBeenCalledTimes(2);
    expect(controller.setAccountState).toHaveBeenLastCalledWith(true, true);
  });
});
