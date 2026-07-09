import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

const workos = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@workos-inc/node", () => ({ createWorkOS: workos.create }));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  safeStorage: {},
}));

import {
  accessTokenNeedsRefresh,
  deriveDesktopAuthCallbackUrl,
  parseTrustedAuthCallbackUrl,
  AuthService,
} from "./AuthService.ts";
import { AuthStore } from "./AuthStore.ts";

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
    const validPayload = Buffer.from(JSON.stringify({ exp: now / 1000 + 61 })).toString(
      "base64url",
    );

    await expect(Effect.runPromise(accessTokenNeedsRefresh("malformed", now))).resolves.toBe(true);
    await expect(
      Effect.runPromise(accessTokenNeedsRefresh(`header.${validPayload}`, now)),
    ).resolves.toBe(true);
    await expect(
      Effect.runPromise(accessTokenNeedsRefresh(`header.${validPayload}.signature.extra`, now)),
    ).resolves.toBe(true);
    await expect(
      Effect.runPromise(accessTokenNeedsRefresh(`header.${validPayload}.invalid+signature`, now)),
    ).resolves.toBe(true);
    await expect(
      Effect.runPromise(accessTokenNeedsRefresh(accessToken({ exp: "invalid" }), now)),
    ).resolves.toBe(true);
  });
});

describe("desktop auth service configuration", () => {
  it("ignores non-callback arguments without loading WorkOS configuration", async () => {
    const storeLayer = Layer.succeed(
      AuthStore,
      AuthStore.of({
        clear: Effect.void,
        get: () => Effect.succeed(null),
        isEncryptionAvailable: Effect.succeed(true),
        set: () => Effect.void,
      }),
    );

    const results = await Effect.runPromise(
      AuthService.use((auth) =>
        Effect.all([
          auth.handleCallbackUrl("--flag"),
          auth.handleCallbackUrl("/Applications/Plakk.app/Contents/MacOS/Plakk"),
          auth.handleCallbackUrl("C:\\Program Files\\Plakk\\Plakk.exe"),
        ]),
      ).pipe(Effect.provide(AuthService.layer.pipe(Layer.provide(storeLayer)))),
    );

    expect(results).toEqual([null, null, null]);
    expect(workos.create).not.toHaveBeenCalled();
  });

  it("acquires and signs out without loading WorkOS configuration", async () => {
    let cleared = false;
    const storeLayer = Layer.succeed(
      AuthStore,
      AuthStore.of({
        clear: Effect.sync(() => {
          cleared = true;
        }),
        get: () => Effect.succeed(null),
        isEncryptionAvailable: Effect.succeed(true),
        set: () => Effect.void,
      }),
    );

    await Effect.runPromise(
      AuthService.use((auth) => auth.signOut()).pipe(
        Effect.provide(AuthService.layer.pipe(Layer.provide(storeLayer))),
      ),
    );

    expect(cleared).toBe(true);
    expect(workos.create).not.toHaveBeenCalled();
  });
});
