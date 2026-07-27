import { describe, expect, it } from "vite-plus/test";

import {
  InvalidBackendProductionConfiguration,
  validateBackendProductionEnvironment,
} from "./ProductionConfig.ts";

const validEnvironment = {
  DATABASE_URL: "postgresql://plakk:database-secret@db.example/plakk",
  NODE_ENV: "production",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://api.axiom.co/v1/logs",
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer logs-secret,X-Axiom-Dataset=plakk",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://api.axiom.co/v1/metrics",
  OTEL_EXPORTER_OTLP_METRICS_HEADERS:
    "Authorization=Bearer metrics-secret,X-Axiom-Metrics-Dataset=plakk",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://api.axiom.co/v1/traces",
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Bearer traces-secret,X-Axiom-Dataset=plakk",
  PLAKK_API_ORIGIN: "https://api.plakk.io",
  PLAKK_ENVIRONMENT: "production",
  PLAKK_RELEASE: "d216771c",
  PLAKK_WEB_ORIGIN: "https://app.plakk.io",
  POLAR_ACCESS_TOKEN: "polar-secret",
  POLAR_ANNUAL_PRODUCT_ID: "annual-product",
  POLAR_MONTHLY_PRODUCT_ID: "monthly-product",
  POLAR_PAID_BENEFIT_ID: "paid-benefit",
  POLAR_SERVER: "production",
  POLAR_WEBHOOK_SECRET: "webhook-secret",
  WORKOS_API_KEY: "sk_live_server-secret",
  WORKOS_CLIENT_ID: "client_live_plakk",
} as const;

describe("backend production configuration", () => {
  it("validates the complete trusted backend deployment before serving", () => {
    expect(validateBackendProductionEnvironment(validEnvironment)).toEqual({
      apiOrigin: "https://api.plakk.io",
      environment: "production",
      release: "d216771c",
      webOrigin: "https://app.plakk.io",
    });
  });

  it("fails closed across database, WorkOS/storage, Polar, telemetry, and origin groups", () => {
    try {
      validateBackendProductionEnvironment({ NODE_ENV: "production" });
      expect.unreachable("production configuration must fail");
    } catch (cause) {
      const error = cause as InvalidBackendProductionConfiguration;
      expect(error.issues).toEqual(
        expect.arrayContaining([
          "DATABASE_URL is required.",
          "WORKOS_API_KEY is required.",
          "WORKOS_CLIENT_ID is required.",
          "POLAR_ACCESS_TOKEN is required.",
          "POLAR_WEBHOOK_SECRET is required.",
          "PLAKK_WEB_ORIGIN is required.",
          "PLAKK_API_ORIGIN is required.",
          "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is required.",
          "OTEL_EXPORTER_OTLP_TRACES_HEADERS is required.",
          "PLAKK_ENVIRONMENT is required.",
          "PLAKK_RELEASE is required.",
        ]),
      );
    }
  });

  it("rejects insecure/cross-deployment origins and telemetry endpoints", () => {
    for (const overrides of [
      { DATABASE_URL: "https://db.example/plakk" },
      { PLAKK_WEB_ORIGIN: "https://preview.plakk.io" },
      { PLAKK_API_ORIGIN: "http://api.plakk.io" },
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://api.axiom.co/v1/traces" },
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://user:secret@api.axiom.co/v1/traces" },
      { OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization" },
      { POLAR_SERVER: "sandbox" },
    ]) {
      expect(() =>
        validateBackendProductionEnvironment({ ...validEnvironment, ...overrides }),
      ).toThrow(InvalidBackendProductionConfiguration);
    }
  });

  it("never retains credential or connection values in failures", () => {
    const secrets = {
      DATABASE_URL: "postgresql://user:exposed-database-password",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Bearer exposed-axiom-token",
      POLAR_ACCESS_TOKEN: "exposed-polar-token",
      WORKOS_API_KEY: "exposed-workos-token",
    };

    try {
      validateBackendProductionEnvironment({ ...validEnvironment, ...secrets });
      expect.unreachable("invalid configuration must fail");
    } catch (cause) {
      const serialized = JSON.stringify(cause);
      for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
    }
  });
});
