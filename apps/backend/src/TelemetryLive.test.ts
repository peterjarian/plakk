import { it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { TelemetryLive } from "./TelemetryLive.ts";

it.effect("builds the production OTEL layer", () =>
  Layer.build(TelemetryLive).pipe(
    Effect.scoped,
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
            OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Bearer test,X-Axiom-Dataset=test",
            OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
            OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer test,X-Axiom-Dataset=test",
            OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4318/v1/metrics",
            OTEL_EXPORTER_OTLP_METRICS_HEADERS:
              "Authorization=Bearer test,X-Axiom-Metrics-Dataset=test",
            PLAKK_ENVIRONMENT: "test",
            PLAKK_RELEASE: "test-release",
          },
        }),
      ),
    ),
    Effect.asVoid,
  ),
);
