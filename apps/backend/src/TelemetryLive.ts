import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";

import { TelemetryConfig, TelemetryConfigLive } from "./telemetry/TelemetryConfig.ts";
import { makeSanitizedTracer } from "./telemetry/TelemetrySanitization.ts";

export const TelemetryLive = Layer.unwrap(
  TelemetryConfig.pipe(
    Effect.map((config) => {
      if (config.signals === null) return Layer.empty;
      const signals = config.signals;
      const sdk = NodeSdk.layer(() => ({
        spanProcessor: new BatchSpanProcessor(
          new OTLPTraceExporter({
            headers: signals.traces.headers,
            url: signals.traces.url,
          }),
        ),
        logRecordProcessor: new BatchLogRecordProcessor(
          new OTLPLogExporter({
            headers: signals.logs.headers,
            url: signals.logs.url,
          }),
        ),
        metricReader: new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            headers: signals.metrics.headers,
            url: signals.metrics.url,
          }),
        }),
        resource: {
          attributes: {
            "deployment.environment.name": config.environment,
            "service.namespace": "plakk",
          },
          serviceName: "plakk-backend",
          serviceVersion: config.release,
        },
      }));
      return Layer.effect(Tracer.Tracer, Tracer.Tracer.pipe(Effect.map(makeSanitizedTracer))).pipe(
        Layer.provideMerge(sdk),
      );
    }),
  ),
).pipe(Layer.provide(TelemetryConfigLive));
