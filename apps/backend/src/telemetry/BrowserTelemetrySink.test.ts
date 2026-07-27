import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/unstable/http";

import {
  BrowserTelemetrySink,
  BrowserTelemetrySinkLive,
  browserSpanToOtlp,
} from "./BrowserTelemetrySink.ts";
import { TelemetryConfig } from "./TelemetryConfig.ts";

describe("browser span OTLP encoding", () => {
  it("uses trusted resource identity and preserves the propagated correlation IDs", () => {
    const payload = browserSpanToOtlp(
      {
        durationMillis: 25,
        errorKind: "FORBIDDEN",
        name: "snippet.delete",
        spanId: "0123456789abcdef",
        startedAtUnixMillis: 1_000,
        status: "ERROR",
        traceId: "0123456789abcdef0123456789abcdef",
      },
      { environment: "production", release: "d216771c" },
    );

    expect(payload).toMatchObject({
      resourceSpans: [
        {
          resource: {
            attributes: expect.arrayContaining([
              { key: "service.name", value: { stringValue: "plakk-web" } },
              { key: "service.version", value: { stringValue: "d216771c" } },
              {
                key: "deployment.environment.name",
                value: { stringValue: "production" },
              },
            ]),
          },
          scopeSpans: [
            {
              spans: [
                {
                  endTimeUnixNano: "1025000000",
                  name: "snippet.delete",
                  spanId: "0123456789abcdef",
                  startTimeUnixNano: "1000000000",
                  status: { code: "STATUS_CODE_ERROR" },
                  traceId: "0123456789abcdef0123456789abcdef",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("FORBIDDEN");
    expect(JSON.stringify(payload)).not.toContain("credential");
  });
});

effectIt.effect("bounds slow Axiom exports and uses the Web-provided release", () =>
  Effect.gen(function* () {
    const sink = yield* BrowserTelemetrySink;
    const fiber = yield* sink
      .exportSpan({
        release: "web-release-abc123",
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
      })
      .pipe(Effect.forkChild);

    yield* TestClock.adjust("5 seconds");
    const result = yield* Fiber.join(fiber).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_REJECTED" },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BrowserTelemetrySinkLive.pipe(
          Layer.provide(
            Layer.succeed(
              TelemetryConfig,
              TelemetryConfig.of({
                environment: "production",
                release: "backend-release-must-not-label-browser-span",
                signals: {
                  logs: { headers: {}, url: "https://api.axiom.co/v1/logs" },
                  metrics: { headers: {}, url: "https://api.axiom.co/v1/metrics" },
                  traces: { headers: {}, url: "https://api.axiom.co/v1/traces" },
                },
              }),
            ),
          ),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.never),
            ),
          ),
        ),
        TestClock.layer(),
      ),
    ),
  ),
);
