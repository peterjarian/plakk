import { Effect, Layer } from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const workos = vi.hoisted(() => ({ authorize: vi.fn(), create: vi.fn() }));

vi.mock("@workos-inc/node", () => ({ createWorkOS: workos.create }));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  safeStorage: {},
}));

import {
  accessTokenNeedsRefresh,
  authRefreshFailureExpiresSession,
  desktopAuthCallbackUrl,
  parseTrustedAuthCallbackUrl,
  AuthService,
} from "./AuthService.ts";
import { AuthServiceLive } from "./AuthServiceLive.ts";
import { AuthStore } from "./AuthStore.ts";

const callbackUrl = new URL("plakk-dev://auth/callback");

function accessToken(claims: unknown): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

beforeEach(() => {
  workos.authorize.mockReset();
  workos.create.mockReset();
});

describe("desktop auth callback matching", () => {
  it("uses separate packaged and development protocols at the desktop callback address", () => {
    expect(desktopAuthCallbackUrl(true).href).toBe("plakk://auth/callback");
    expect(desktopAuthCallbackUrl(false).href).toBe("plakk-dev://auth/callback");
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

  it("expires only sessions whose refresh credentials were rejected", () => {
    expect(authRefreshFailureExpiresSession({ status: 400 })).toBe(true);
    expect(authRefreshFailureExpiresSession({ status: 401 })).toBe(true);

    expect(authRefreshFailureExpiresSession(new TypeError("fetch failed"))).toBe(false);
    expect(authRefreshFailureExpiresSession({ status: 403 })).toBe(false);
    expect(authRefreshFailureExpiresSession({ status: 408 })).toBe(false);
    expect(authRefreshFailureExpiresSession({ status: 429 })).toBe(false);
    expect(authRefreshFailureExpiresSession({ status: 422 })).toBe(false);
    expect(authRefreshFailureExpiresSession({ status: 500 })).toBe(false);
  });
});

describe("desktop auth service configuration", () => {
  it("uses the web handoff for WorkOS while retaining the private desktop callback", async () => {
    let storedPkce: unknown = null;
    workos.authorize.mockResolvedValue({
      codeVerifier: "code-verifier",
      state: "auth-state",
      url: "https://api.workos.com/user_management/authorize",
    });
    workos.create.mockReturnValue({
      userManagement: { getAuthorizationUrlWithPKCE: workos.authorize },
    });

    const storeLayer = Layer.succeed(
      AuthStore,
      AuthStore.of({
        clear: Effect.void,
        get: () => Effect.succeed(null),
        isEncryptionAvailable: Effect.succeed(true),
        set: (key, value) =>
          Effect.sync(() => {
            if (key === "pkce") storedPkce = value;
          }),
      }),
    );

    const result = await Effect.runPromise(
      AuthService.use((auth) =>
        Effect.all({
          authorizationUrl: auth.startSignIn(),
          callbackUrl: auth.callbackUrl,
        }),
      ).pipe(
        Effect.provide(AuthServiceLive.pipe(Layer.provide(storeLayer))),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {
              WORKOS_CLIENT_ID: "client_desktop",
              WORKOS_REDIRECT_URI: "https://app.plakk.io/auth/desktop/callback",
            },
          }),
        ),
      ),
    );

    expect(result).toEqual({
      authorizationUrl: "https://api.workos.com/user_management/authorize",
      callbackUrl: "plakk-dev://auth/callback",
    });
    expect(workos.authorize).toHaveBeenCalledWith({
      clientId: "client_desktop",
      provider: "authkit",
      redirectUri: "https://app.plakk.io/auth/desktop/callback",
    });
    expect(storedPkce).toMatchObject({
      codeVerifier: "code-verifier",
      state: "auth-state",
    });
  });

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
      ).pipe(Effect.provide(AuthServiceLive.pipe(Layer.provide(storeLayer)))),
    );

    expect(results).toEqual([null, null, null]);
    expect(workos.create).not.toHaveBeenCalled();
  });

  it("acquires and signs out without loading WorkOS configuration", async () => {
    const clearedKeys: Array<string> = [];
    const storeLayer = Layer.succeed(
      AuthStore,
      AuthStore.of({
        clear: Effect.void,
        get: () => Effect.succeed(null),
        isEncryptionAvailable: Effect.succeed(true),
        set: (key, value) =>
          Effect.sync(() => {
            if (value === null) clearedKeys.push(key);
          }),
      }),
    );

    await Effect.runPromise(
      AuthService.use((auth) => auth.signOut()).pipe(
        Effect.provide(AuthServiceLive.pipe(Layer.provide(storeLayer))),
      ),
    );

    expect(clearedKeys).toEqual(["credentials", "pkce"]);
    expect(workos.create).not.toHaveBeenCalled();
  });
});
