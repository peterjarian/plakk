import { describe, expect, it } from "vite-plus/test";

import { trustedAuthReturnPath } from "./-auth-return.ts";

describe("authenticated route return", () => {
  it("preserves the supported storage reconstruction fields", () => {
    expect(
      trustedAuthReturnPath("/storage?provider=DROPBOX&origin=desktop&confirmation=provider"),
    ).toBe("/storage?provider=DROPBOX&origin=desktop&confirmation=provider");
  });

  it("rejects external and unsupported return targets", () => {
    for (const value of [
      "https://evil.example/storage",
      "//evil.example/storage",
      "/settings",
      "javascript:alert(1)",
    ]) {
      expect(trustedAuthReturnPath(value)).toBeUndefined();
    }
  });

  it("drops unsupported storage query fields", () => {
    expect(
      trustedAuthReturnPath(
        "/storage?provider=google-drive&origin=DESKTOP&confirmation=true&next=https://evil.example",
      ),
    ).toBe("/storage");
  });
});
