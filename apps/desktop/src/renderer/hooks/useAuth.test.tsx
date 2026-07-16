import { describe, expect, it } from "vite-plus/test";

import { authIssueAfter } from "./useAuth.ts";

describe("authIssueAfter", () => {
  it.each([
    ["get", "Could not check session."],
    ["signIn", "Could not start sign-in."],
    ["signOut", "Could not sign out."],
  ] as const)("uses a controlled fallback when %s rejects", (operation, message) => {
    expect(
      authIssueAfter({
        _tag: "Rejected",
        operation,
        cause: new Error("sensitive transport details"),
      }),
    ).toEqual({ message });
  });

  it("preserves authored messages from structured auth error events", () => {
    expect(
      authIssueAfter({
        _tag: "StructuredError",
        error: { message: "Your session expired. Sign in again." },
      }),
    ).toEqual({ message: "Your session expired. Sign in again." });
  });

  it("clears the previous issue when a new operation starts or status arrives", () => {
    expect(authIssueAfter({ _tag: "Clear" })).toBeNull();
  });
});
