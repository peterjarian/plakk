import { describe, expect, it, vi } from "vite-plus/test";
import type { AuthStatus } from "../ipc/contracts.ts";
import { isReloadShortcut, reconcileTrayAuth } from "./lifecycle.ts";

const signedIn: AuthStatus = {
  accessToken: "token",
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

  it("creates the tray only for signed-in sessions and removes it on sign-out", () => {
    const controller = { setup: vi.fn(), disable: vi.fn() };

    reconcileTrayAuth({ accessToken: null, user: null }, controller);
    expect(controller.disable).toHaveBeenCalledOnce();
    expect(controller.setup).not.toHaveBeenCalled();

    reconcileTrayAuth(signedIn, controller);
    expect(controller.setup).toHaveBeenCalledOnce();

    reconcileTrayAuth({ accessToken: null, user: null }, controller);
    expect(controller.disable).toHaveBeenCalledTimes(2);
  });
});
