import { describe, expect, it } from "vite-plus/test";
import { CookieSessionStorage, type CookieOptions } from "@workos/authkit-session";

import { PLAKK_PRODUCTION_AUTH_CALLBACK_URL } from "@plakk/shared/ProductionIdentities";
import {
  InvalidWebProductionConfiguration,
  validateWebProductionEnvironment,
} from "./server-production-config.ts";

class InspectableCookieStorage extends CookieSessionStorage<never, never> {
  override getCookie(): Promise<null> {
    return Promise.resolve(null);
  }

  options(): CookieOptions {
    return this.cookieOptions;
  }
}

const validEnvironment = {
  NODE_ENV: "production",
  PLAKK_WEB_ORIGIN: "https://app.plakk.io",
  VITE_PLAKK_API_ORIGIN: "https://api.plakk.io",
  VITE_PLAKK_ENVIRONMENT: "production",
  VITE_PLAKK_RELEASE: "d216771c",
  WORKOS_API_KEY: "sk_live_server-secret",
  WORKOS_CLIENT_ID: "client_live_plakk",
  WORKOS_COOKIE_PASSWORD: "a-production-cookie-password-over-32-characters",
  WORKOS_REDIRECT_URI: "https://app.plakk.io/api/auth/callback",
} as const;

describe("Web production configuration", () => {
  it("accepts only the canonical HTTPS Web, API, and callback identities", () => {
    expect(validateWebProductionEnvironment(validEnvironment)).toEqual({
      apiOrigin: "https://api.plakk.io",
      environment: "production",
      release: "d216771c",
      webOrigin: "https://app.plakk.io",
      workosRedirectUri: "https://app.plakk.io/api/auth/callback",
    });
  });

  it("fails closed when every required configuration group is absent", () => {
    expect(() => validateWebProductionEnvironment({ NODE_ENV: "production" })).toThrow(
      InvalidWebProductionConfiguration,
    );

    try {
      validateWebProductionEnvironment({ NODE_ENV: "production" });
      expect.unreachable("production configuration must fail");
    } catch (cause) {
      const error = cause as InvalidWebProductionConfiguration;
      expect(error.issues).toEqual(
        expect.arrayContaining([
          "PLAKK_WEB_ORIGIN is required.",
          "VITE_PLAKK_API_ORIGIN is required.",
          "WORKOS_API_KEY is required.",
          "WORKOS_CLIENT_ID is required.",
          "WORKOS_COOKIE_PASSWORD is required.",
          "WORKOS_REDIRECT_URI is required.",
          "VITE_PLAKK_ENVIRONMENT is required.",
          "VITE_PLAKK_RELEASE is required.",
        ]),
      );
    }
  });

  it("rejects non-canonical callbacks, insecure cookies, and broadened cookie scope", () => {
    for (const overrides of [
      { PLAKK_WEB_ORIGIN: "https://preview.plakk.io" },
      { VITE_PLAKK_API_ORIGIN: "http://api.plakk.io" },
      { WORKOS_REDIRECT_URI: "https://app.plakk.io/api/auth/callback?next=evil" },
      { WORKOS_COOKIE_PASSWORD: "too-short" },
      { WORKOS_COOKIE_DOMAIN: ".plakk.io" },
      { WORKOS_COOKIE_SAME_SITE: "none" },
    ]) {
      expect(() => validateWebProductionEnvironment({ ...validEnvironment, ...overrides })).toThrow(
        InvalidWebProductionConfiguration,
      );
    }
  });

  it("makes AuthKit session cookies host-only, HttpOnly, Secure, and Lax", () => {
    const storage = new InspectableCookieStorage({
      apiHttps: true,
      apiKey: validEnvironment.WORKOS_API_KEY,
      clientId: validEnvironment.WORKOS_CLIENT_ID,
      cookieMaxAge: 60 * 60 * 24,
      cookieName: "wos-session",
      cookiePassword: validEnvironment.WORKOS_COOKIE_PASSWORD,
      cookieSameSite: "lax",
      redirectUri: PLAKK_PRODUCTION_AUTH_CALLBACK_URL,
    });

    expect(storage.options()).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });
    expect(storage.options().domain).toBeUndefined();
  });

  it("never includes secret values in validation errors", () => {
    const secrets = {
      WORKOS_API_KEY: "exposed-api-key-value",
      WORKOS_COOKIE_PASSWORD: "exposed-cookie-password",
    };

    try {
      validateWebProductionEnvironment({ ...validEnvironment, ...secrets });
      expect.unreachable("invalid secrets must fail");
    } catch (cause) {
      const serialized = JSON.stringify(cause);
      expect(serialized).not.toContain(secrets.WORKOS_API_KEY);
      expect(serialized).not.toContain(secrets.WORKOS_COOKIE_PASSWORD);
    }
  });
});
