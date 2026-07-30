import { describe, expect, it } from "vite-plus/test";

import { desktopAuthDeepLink } from "./callback.tsx";

describe("desktop auth browser handoff", () => {
  it("preserves the WorkOS callback query for the development app", () => {
    expect(desktopAuthDeepLink("?code=auth-code&state=auth-state", true)).toBe(
      "plakk-dev://auth/callback?code=auth-code&state=auth-state",
    );
  });

  it("preserves the WorkOS callback query for the packaged app", () => {
    expect(
      desktopAuthDeepLink(
        "?error=access_denied&error_description=Sign-in%20was%20cancelled&state=auth-state",
        false,
      ),
    ).toBe(
      "plakk://auth/callback?error=access_denied&error_description=Sign-in%20was%20cancelled&state=auth-state",
    );
  });

  it("normalizes a query without changing its values", () => {
    expect(desktopAuthDeepLink("code=a%2Bb&state=a%2Fb", false)).toBe(
      "plakk://auth/callback?code=a%2Bb&state=a%2Fb",
    );
  });
});
