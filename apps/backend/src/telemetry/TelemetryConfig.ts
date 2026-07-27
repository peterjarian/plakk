import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

type TelemetrySignalConfig = {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
};

export type TelemetryConfiguration = {
  readonly environment: string;
  readonly release: string;
  readonly signals: {
    readonly logs: TelemetrySignalConfig;
    readonly metrics: TelemetrySignalConfig;
    readonly traces: TelemetrySignalConfig;
  } | null;
};

export class TelemetryConfig extends Context.Service<TelemetryConfig, TelemetryConfiguration>()(
  "@plakk/backend/telemetry/TelemetryConfig",
) {}

export const parseOtlpHeaders = (value: string): Readonly<Record<string, string>> => {
  const headers: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator).trim();
    const headerValue = entry.slice(separator + 1).trim();
    if (
      separator <= 0 ||
      !/^[A-Za-z0-9-]+$/.test(name) ||
      headerValue === "" ||
      /[\r\n]/.test(headerValue)
    ) {
      throw new TypeError("OTEL exporter headers are invalid.");
    }
    headers[name] = headerValue;
  }
  if (Object.keys(headers).length === 0) {
    throw new TypeError("OTEL exporter headers are invalid.");
  }
  return headers;
};

export const validatedTelemetryEndpoint = (value: string, production: boolean): string => {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (production && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new TypeError();
    }
    return url.toString();
  } catch {
    throw new TypeError(
      production
        ? "OTEL exporter endpoint must be a credential-free HTTPS URL."
        : "OTEL exporter endpoint must be a credential-free HTTP(S) URL.",
    );
  }
};

const optionalRedactedString = (name: string) =>
  Config.option(Config.redacted(name)).pipe(
    Effect.map(Option.map(Redacted.value)),
    Effect.map(Option.getOrUndefined),
  );

const optionalString = (name: string) =>
  Config.option(Config.string(name)).pipe(Effect.map(Option.getOrUndefined));

export const TelemetryConfigLive = Layer.effect(
  TelemetryConfig,
  Effect.gen(function* () {
    const values = yield* Effect.all({
      environment: optionalString("PLAKK_ENVIRONMENT"),
      logsHeaders: optionalRedactedString("OTEL_EXPORTER_OTLP_LOGS_HEADERS"),
      logsUrl: optionalString("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"),
      metricsHeaders: optionalRedactedString("OTEL_EXPORTER_OTLP_METRICS_HEADERS"),
      metricsUrl: optionalString("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
      nodeEnv: Config.string("NODE_ENV").pipe(Config.withDefault("development")),
      release: optionalString("PLAKK_RELEASE"),
      tracesHeaders: optionalRedactedString("OTEL_EXPORTER_OTLP_TRACES_HEADERS"),
      tracesUrl: optionalString("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
    });
    const configuredSignals = [
      values.logsHeaders,
      values.logsUrl,
      values.metricsHeaders,
      values.metricsUrl,
      values.tracesHeaders,
      values.tracesUrl,
    ];
    const hasTelemetry = configuredSignals.some((value) => value !== undefined);
    if (hasTelemetry && configuredSignals.some((value) => value === undefined)) {
      return yield* Effect.die(
        new Error("Every OTEL endpoint and server-owned header collection must be configured."),
      );
    }
    const production = values.nodeEnv === "production";
    const signals =
      hasTelemetry &&
      values.logsHeaders !== undefined &&
      values.logsUrl !== undefined &&
      values.metricsHeaders !== undefined &&
      values.metricsUrl !== undefined &&
      values.tracesHeaders !== undefined &&
      values.tracesUrl !== undefined
        ? {
            logs: {
              headers: parseOtlpHeaders(values.logsHeaders),
              url: validatedTelemetryEndpoint(values.logsUrl, production),
            },
            metrics: {
              headers: parseOtlpHeaders(values.metricsHeaders),
              url: validatedTelemetryEndpoint(values.metricsUrl, production),
            },
            traces: {
              headers: parseOtlpHeaders(values.tracesHeaders),
              url: validatedTelemetryEndpoint(values.tracesUrl, production),
            },
          }
        : null;

    return TelemetryConfig.of({
      environment: values.environment ?? values.nodeEnv,
      release: values.release ?? "development",
      signals,
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.die(
        cause instanceof Error
          ? cause
          : new Error("Telemetry configuration could not be validated."),
      ),
    ),
  ),
);
