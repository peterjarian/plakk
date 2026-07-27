import type { BrowserTelemetryExport, BrowserTelemetrySpan } from "@plakk/shared/BrowserTelemetry";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { TelemetryConfig } from "./TelemetryConfig.ts";

type BrowserTelemetryResource = {
  readonly environment: string;
  readonly release: string;
};

export const BROWSER_TELEMETRY_EXPORT_TIMEOUT = "5 seconds";

const stringAttribute = (key: string, value: string) => ({
  key,
  value: { stringValue: value },
});

export const browserSpanToOtlp = (
  span: BrowserTelemetrySpan,
  resource: BrowserTelemetryResource,
) => {
  const startTimeUnixNano = BigInt(span.startedAtUnixMillis) * 1_000_000n;
  const endTimeUnixNano = startTimeUnixNano + BigInt(span.durationMillis) * 1_000_000n;

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttribute("deployment.environment.name", resource.environment),
            stringAttribute("service.name", "plakk-web"),
            stringAttribute("service.version", resource.release),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "plakk.web.browser-actions", version: resource.release },
            spans: [
              {
                endTimeUnixNano: endTimeUnixNano.toString(),
                kind: "SPAN_KIND_CLIENT",
                name: span.name,
                spanId: span.spanId,
                startTimeUnixNano: startTimeUnixNano.toString(),
                status: {
                  code: span.status === "OK" ? "STATUS_CODE_OK" : "STATUS_CODE_ERROR",
                },
                traceId: span.traceId,
              },
            ],
          },
        ],
      },
    ],
  };
};

export class BrowserTelemetrySinkError extends Data.TaggedError("BrowserTelemetrySinkError")<{
  readonly code: "NOT_CONFIGURED" | "UPSTREAM_REJECTED";
}> {}

export class BrowserTelemetrySink extends Context.Service<
  BrowserTelemetrySink,
  {
    readonly exportSpan: (
      telemetry: BrowserTelemetryExport,
    ) => Effect.Effect<void, BrowserTelemetrySinkError>;
  }
>()("@plakk/backend/telemetry/BrowserTelemetrySink") {}

export const BrowserTelemetrySinkLive = Layer.effect(
  BrowserTelemetrySink,
  Effect.gen(function* () {
    const config = yield* TelemetryConfig;
    const httpClient = yield* HttpClient.HttpClient;
    return BrowserTelemetrySink.of({
      exportSpan: (telemetry) => {
        if (config.signals === null) {
          return Effect.fail(new BrowserTelemetrySinkError({ code: "NOT_CONFIGURED" }));
        }
        const payload = browserSpanToOtlp(telemetry.span, {
          environment: config.environment,
          release: telemetry.release,
        });
        return httpClient
          .post(config.signals.traces.url, {
            body: HttpBody.text(JSON.stringify(payload), "application/json"),
            headers: config.signals.traces.headers,
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.asVoid,
            Effect.timeout(BROWSER_TELEMETRY_EXPORT_TIMEOUT),
            Effect.mapError(() => new BrowserTelemetrySinkError({ code: "UPSTREAM_REJECTED" })),
          );
      },
    });
  }),
);
