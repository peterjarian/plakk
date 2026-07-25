import { describe, expect, it, vi } from "vite-plus/test";

import { makeAuthCommands } from "./useAuth.ts";

describe("auth commands", () => {
  it("keeps a rejected sign-in command in auth-owned issue state", async () => {
    const setIssue = vi.fn();
    const commands = makeAuthCommands(
      {
        signIn: () => Promise.reject(new Error("Could not open sign-in.")),
        signOut: () => Promise.resolve(),
      },
      setIssue,
    );

    await expect(commands.signIn()).resolves.toBe(false);
    expect(setIssue).toHaveBeenLastCalledWith({ message: "Could not open sign-in." });
  });

  it("only reports sign-out success after the IPC command completes", async () => {
    const setIssue = vi.fn();
    const commands = makeAuthCommands(
      {
        signIn: () => Promise.resolve(),
        signOut: () => Promise.reject(null),
      },
      setIssue,
    );

    await expect(commands.signOut()).resolves.toBe(false);
    expect(setIssue).toHaveBeenLastCalledWith({ message: "Couldn’t sign out of Plakk." });
  });
});
