import { describe, expect, it } from "vite-plus/test";

import {
  allowedBackendOrigins,
  BACKEND_CORS_ALLOWED_HEADERS,
  InvalidCorsConfiguration,
} from "./cors.ts";

describe("backend CORS origins", () => {
  it("retains a Desktop-only allowlist when no Web client is configured", () => {
    expect(allowedBackendOrigins(undefined)).toEqual(["plakk-app://renderer"]);
  });

  it("retains Desktop and adds one exact configured Web origin", () => {
    expect(allowedBackendOrigins("https://app.plakk.io")).toEqual([
      "plakk-app://renderer",
      "https://app.plakk.io",
    ]);
    expect(allowedBackendOrigins("http://localhost:3000")).toEqual([
      "plakk-app://renderer",
      "http://localhost:3000",
    ]);
  });

  it("requires an exact HTTPS Web origin in production", () => {
    expect(allowedBackendOrigins("https://app.plakk.io", true)).toEqual([
      "plakk-app://renderer",
      "https://app.plakk.io",
    ]);
    expect(() => allowedBackendOrigins("http://app.plakk.io", true)).toThrow(
      "PLAKK_WEB_ORIGIN must be an exact HTTP(S) origin.",
    );
    expect(() => allowedBackendOrigins(undefined, true)).toThrow(
      "PLAKK_WEB_ORIGIN is required in production.",
    );
  });

  it("admits standard trace propagation without broadening request headers", () => {
    expect(BACKEND_CORS_ALLOWED_HEADERS).toEqual([
      "authorization",
      "content-type",
      "traceparent",
      "tracestate",
    ]);
  });

  it("rejects paths, credentials, and non-HTTP Web origins", () => {
    for (const value of [
      "https://app.plakk.io/path",
      "https://user@app.plakk.io",
      "plakk-app://renderer",
    ]) {
      expect(() => allowedBackendOrigins(value)).toThrow(
        "PLAKK_WEB_ORIGIN must be an exact HTTP(S) origin.",
      );
    }
  });

  it("does not retain malformed configuration values in its error cause", () => {
    const configuredOrigin = "https://user:password@example.com";
    try {
      allowedBackendOrigins(configuredOrigin);
      expect.unreachable("invalid origins must fail");
    } catch (cause) {
      expect(cause).toBeInstanceOf(InvalidCorsConfiguration);
      expect((cause as InvalidCorsConfiguration).cause).toBe("redacted-invalid-web-origin");
      expect(JSON.stringify(cause)).not.toContain(configuredOrigin);
      expect(JSON.stringify(cause)).not.toContain("password");
    }
  });
});
