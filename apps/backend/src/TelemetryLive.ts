import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const telemetryEnabled = Config.option(Config.string("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"));

export const TelemetryLive = Layer.unwrap(
  telemetryEnabled.pipe(
    Effect.map((endpoint) =>
      Option.isNone(endpoint)
        ? Layer.empty
        : NodeSdk.layer(() => ({
            spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
            logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
            metricReader: new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter(),
            }),
            resource: { serviceName: "plakk-backend" },
          })),
    ),
  ),
);
