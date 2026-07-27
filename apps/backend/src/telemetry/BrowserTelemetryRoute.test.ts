import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { HttpEffect } from "effect/unstable/http";

import { WorkosAccessTokenVerifier } from "../middleware/WorkosAccessTokenVerifier.ts";
import { BrowserTelemetryRateLimiter } from "./BrowserTelemetryRateLimiter.ts";
import { handleBrowserTelemetryRequest } from "./BrowserTelemetryRoute.ts";
import { BrowserTelemetrySink } from "./BrowserTelemetrySink.ts";

const telemetryBody = () =>
  JSON.stringify({
    release: "web-release-abc123",
    schemaVersion: 1,
    span: {
      durationMillis: 25,
      errorKind: null,
      name: "snippet.delete",
      spanId: "0123456789abcdef",
      startedAtUnixMillis: 0,
      status: "OK",
      traceId: "0123456789abcdef0123456789abcdef",
    },
  });

const makeHandler = (allowed: boolean) => {
  const allow = vi.fn(() => Effect.succeed(allowed));
  const exportSpan = vi.fn(() => Effect.void);
  const verify = vi.fn(() => Effect.succeed({ id: "workos-user" }));
  const services = Layer.mergeAll(
    Layer.succeed(BrowserTelemetryRateLimiter, BrowserTelemetryRateLimiter.of({ allow })),
    Layer.succeed(BrowserTelemetrySink, BrowserTelemetrySink.of({ exportSpan })),
    Layer.succeed(WorkosAccessTokenVerifier, WorkosAccessTokenVerifier.of({ verify })),
  );
  const handler = HttpEffect.toWebHandler(
    handleBrowserTelemetryRequest("https://app.plakk.io").pipe(
      Effect.provide(Layer.merge(services, TestClock.layer())),
    ),
  );
  return { allow, exportSpan, handler, verify };
};

const request = (
  overrides: {
    readonly authorization?: string;
    readonly origin?: string;
  } = {},
) =>
  new Request("https://api.plakk.io/api/telemetry/v1/traces", {
    body: telemetryBody(),
    headers: {
      authorization: overrides.authorization ?? "Bearer access-token",
      "content-type": "application/json",
      origin: overrides.origin ?? "https://app.plakk.io",
    },
    method: "POST",
  });

describe("browser telemetry HTTP route", () => {
  it("wires exact-origin authentication, per-user admission, and export", async () => {
    const target = makeHandler(true);
    const response = await target.handler(request());

    expect(response.status).toBe(204);
    expect(target.verify).toHaveBeenCalledWith("access-token");
    expect(target.allow).toHaveBeenCalledWith("workos-user");
    expect(target.exportSpan).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin and over-limit requests before export", async () => {
    const crossOrigin = makeHandler(true);
    const overLimit = makeHandler(false);

    expect(
      (await crossOrigin.handler(request({ origin: "https://attacker.example" }))).status,
    ).toBe(403);
    expect(crossOrigin.verify).not.toHaveBeenCalled();
    expect(crossOrigin.exportSpan).not.toHaveBeenCalled();

    expect((await overLimit.handler(request())).status).toBe(429);
    expect(overLimit.verify).toHaveBeenCalledWith("access-token");
    expect(overLimit.exportSpan).not.toHaveBeenCalled();
  });
});
