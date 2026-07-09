import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  safeStorage: {},
}));

import {
  accessTokenNeedsRefresh,
  deriveDesktopAuthCallbackUrl,
  parseTrustedAuthCallbackUrl,
} from "./AuthService.ts";

const callbackUrl = new URL("plakk-dev://auth/callback");

function accessToken(claims: unknown): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

describe("desktop auth callback matching", () => {
  it("derives the packaged and development protocols without changing the callback address", () => {
    const configuredUrl = new URL("plakk://auth/callback");

    expect(deriveDesktopAuthCallbackUrl(configuredUrl, true).href).toBe("plakk://auth/callback");
    expect(deriveDesktopAuthCallbackUrl(configuredUrl, false).href).toBe(
      "plakk-dev://auth/callback",
    );
  });

  it("accepts only the configured protocol, host, and path", () => {
    expect(
      parseTrustedAuthCallbackUrl("plakk-dev://auth/callback?code=abc", callbackUrl)?.href,
    ).toBe("plakk-dev://auth/callback?code=abc");
    expect(parseTrustedAuthCallbackUrl("plakk://auth/callback?code=abc", callbackUrl)).toBeNull();
    expect(
      parseTrustedAuthCallbackUrl("plakk-dev://other/callback?code=abc", callbackUrl),
    ).toBeNull();
    expect(parseTrustedAuthCallbackUrl("plakk-dev://auth/other?code=abc", callbackUrl)).toBeNull();
  });

  it("rejects malformed callback URLs", () => {
    expect(parseTrustedAuthCallbackUrl("not a url", callbackUrl)).toBeNull();
  });
});

describe("desktop access token refresh", () => {
  const now = 1_000_000;

  it("keeps tokens valid beyond the refresh window", async () => {
    await expect(
      Effect.runPromise(accessTokenNeedsRefresh(accessToken({ exp: now / 1000 + 61 }), now)),
    ).resolves.toBe(false);
  });

  it("refreshes tokens inside the refresh window or already expired", async () => {
    await expect(
      Effect.runPromise(accessTokenNeedsRefresh(accessToken({ exp: now / 1000 + 60 }), now)),
    ).resolves.toBe(true);
    await expect(
      Effect.runPromise(accessTokenNeedsRefresh(accessToken({ exp: now / 1000 - 1 }), now)),
    ).resolves.toBe(true);
  });

  it("refreshes malformed tokens", async () => {
    await expect(Effect.runPromise(accessTokenNeedsRefresh("malformed", now))).resolves.toBe(true);
    await expect(
      Effect.runPromise(accessTokenNeedsRefresh(accessToken({ exp: "invalid" }), now)),
    ).resolves.toBe(true);
  });
});
