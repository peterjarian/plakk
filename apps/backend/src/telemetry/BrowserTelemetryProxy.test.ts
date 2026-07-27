import { describe, expect, it, vi } from "vite-plus/test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import {
  BrowserTelemetryProxyRejection,
  ingestBrowserTelemetry,
  type BrowserTelemetryProxyDependencies,
} from "./BrowserTelemetryProxy.ts";

const body = JSON.stringify({
  schemaVersion: 1,
  span: {
    durationMillis: 25,
    errorKind: null,
    name: "snippet.delete",
    spanId: "0123456789abcdef",
    startedAtUnixMillis: 1_000,
    status: "OK",
    traceId: "0123456789abcdef0123456789abcdef",
  },
});

const dependencies = (
  overrides: Partial<BrowserTelemetryProxyDependencies> = {},
): BrowserTelemetryProxyDependencies => ({
  allow: vi.fn(() => Effect.succeed(true)),
  exportSpan: vi.fn(() => Effect.void),
  now: () => 1_100,
  verifyAccessToken: vi.fn(() => Effect.succeed({ id: "workos-user" })),
  ...overrides,
});

const request = (overrides: Partial<Parameters<typeof ingestBrowserTelemetry>[0]> = {}) => ({
  authorization: "Bearer access-token",
  body,
  contentType: "application/json",
  expectedOrigin: "https://app.plakk.io",
  origin: "https://app.plakk.io",
  ...overrides,
});

describe("authenticated browser telemetry proxy", () => {
  it("accepts one strict sanitized span after origin/auth/rate checks", async () => {
    const deps = dependencies();

    await Effect.runPromise(ingestBrowserTelemetry(request(), deps));

    expect(deps.verifyAccessToken).toHaveBeenCalledWith("access-token");
    expect(deps.allow).toHaveBeenCalledWith("workos-user");
    expect(deps.exportSpan).toHaveBeenCalledWith({
      durationMillis: 25,
      errorKind: null,
      name: "snippet.delete",
      spanId: "0123456789abcdef",
      startedAtUnixMillis: 1_000,
      status: "OK",
      traceId: "0123456789abcdef0123456789abcdef",
    });
  });

  it("rejects missing authentication, wrong origins, unsupported media, and rate abuse", async () => {
    const cases = [
      {
        deps: dependencies(),
        input: request({ authorization: undefined }),
        rejection: { code: "UNAUTHENTICATED", status: 401 },
      },
      {
        deps: dependencies(),
        input: request({ origin: "https://evil.example" }),
        rejection: { code: "ORIGIN_REJECTED", status: 403 },
      },
      {
        deps: dependencies(),
        input: request({ contentType: "text/plain" }),
        rejection: { code: "UNSUPPORTED_MEDIA_TYPE", status: 415 },
      },
      {
        deps: dependencies({ allow: () => Effect.succeed(false) }),
        input: request(),
        rejection: { code: "RATE_LIMITED", status: 429 },
      },
    ] as const;

    for (const testCase of cases) {
      const result = await Effect.runPromise(
        ingestBrowserTelemetry(testCase.input, testCase.deps).pipe(Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: testCase.rejection,
      });
      expect(testCase.deps.exportSpan).not.toHaveBeenCalled();
    }
  });

  it("rejects oversized, stale, malformed, and internally inconsistent envelopes", async () => {
    const cases = [
      request({ body: "x".repeat(16_385) }),
      request({
        body: body.replace('"startedAtUnixMillis":1000', '"startedAtUnixMillis":1'),
        expectedOrigin: "https://app.plakk.io",
      }),
      request({ body: "{" }),
      request({ body: body.replace('"status":"OK"', '"status":"ERROR"') }),
    ];

    for (const input of cases) {
      const deps = dependencies({ now: () => 600_000 });
      const result = await Effect.runPromise(
        ingestBrowserTelemetry(input, deps).pipe(Effect.result),
      );
      expect(result).toMatchObject({ _tag: "Failure" });
      expect(deps.exportSpan).not.toHaveBeenCalled();
    }
  });

  it("rejects every protected-data field instead of silently forwarding it", async () => {
    const protectedFields = [
      "snippetContent",
      "fileName",
      "clipboardData",
      "credential",
      "cookie",
      "authorizationCode",
      "signedProviderUrl",
      "rawProviderBody",
    ];

    for (const protectedField of protectedFields) {
      const deps = dependencies();
      const parsed = JSON.parse(body) as { span: Record<string, unknown> };
      parsed.span[protectedField] = `protected-${protectedField}-value`;
      const result = await Effect.runPromise(
        ingestBrowserTelemetry(request({ body: JSON.stringify(parsed) }), deps).pipe(Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "INVALID_ENVELOPE", status: 400 },
      });
      expect(JSON.stringify(result)).not.toContain(`protected-${protectedField}-value`);
      expect(deps.exportSpan).not.toHaveBeenCalled();
    }
  });

  it("collapses verifier and upstream failures without retaining their secrets", async () => {
    const secret = "provider-body-with-cookie-and-signed-url";
    class ProtectedDependencyFailure extends Data.TaggedError("ProtectedDependencyFailure")<{
      readonly protectedValue: string;
    }> {}
    const failures = [
      dependencies({
        verifyAccessToken: () =>
          Effect.fail(new ProtectedDependencyFailure({ protectedValue: secret })),
      }),
      dependencies({
        exportSpan: () => Effect.fail(new ProtectedDependencyFailure({ protectedValue: secret })),
      }),
    ];

    for (const deps of failures) {
      const result = await Effect.runPromise(
        ingestBrowserTelemetry(request(), deps).pipe(Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: expect.any(BrowserTelemetryProxyRejection),
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});
