import { PLAKK_PRODUCTION_IDENTITIES } from "@plakk/shared/ProductionIdentities";

import { parseOtlpHeaders, validatedTelemetryEndpoint } from "./telemetry/TelemetryConfig.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type BackendProductionConfiguration = {
  readonly apiOrigin: typeof PLAKK_PRODUCTION_IDENTITIES.api;
  readonly environment: string;
  readonly release: string;
  readonly webOrigin: typeof PLAKK_PRODUCTION_IDENTITIES.web;
};

export class InvalidBackendProductionConfiguration extends Error {
  override readonly name = "InvalidBackendProductionConfiguration";
  readonly issues: ReadonlyArray<string>;

  constructor(issues: ReadonlyArray<string>) {
    super(`Invalid backend production configuration:\n${issues.join("\n")}`);
    this.issues = issues;
  }
}

const required = (env: Environment, name: string, issues: Array<string>): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    issues.push(`${name} is required.`);
    return "";
  }
  return value;
};

const requirePostgresUrl = (value: string, issues: Array<string>): void => {
  if (value === "") return;
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname === "" ||
      url.pathname === "" ||
      url.pathname === "/"
    ) {
      issues.push("DATABASE_URL must be a PostgreSQL connection URL.");
    }
  } catch {
    issues.push("DATABASE_URL must be a PostgreSQL connection URL.");
  }
};

export const validateBackendProductionEnvironment = (
  env: Environment,
): BackendProductionConfiguration => {
  const issues: Array<string> = [];
  const databaseUrl = required(env, "DATABASE_URL", issues);
  const apiOrigin = required(env, "PLAKK_API_ORIGIN", issues);
  const webOrigin = required(env, "PLAKK_WEB_ORIGIN", issues);
  const environment = required(env, "PLAKK_ENVIRONMENT", issues);
  const release = required(env, "PLAKK_RELEASE", issues);
  const workosApiKey = required(env, "WORKOS_API_KEY", issues);
  const workosClientId = required(env, "WORKOS_CLIENT_ID", issues);

  for (const name of [
    "POLAR_ACCESS_TOKEN",
    "POLAR_ANNUAL_PRODUCT_ID",
    "POLAR_MONTHLY_PRODUCT_ID",
    "POLAR_PAID_BENEFIT_ID",
    "POLAR_WEBHOOK_SECRET",
  ]) {
    required(env, name, issues);
  }

  for (const name of [
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
    "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  ]) {
    const value = required(env, name, issues);
    if (value !== "") {
      try {
        parseOtlpHeaders(value);
      } catch {
        issues.push(`${name} is invalid.`);
      }
    }
  }

  for (const name of [
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  ]) {
    const value = required(env, name, issues);
    if (value !== "") {
      try {
        validatedTelemetryEndpoint(value, true);
      } catch {
        issues.push(`${name} must be a credential-free HTTPS URL.`);
      }
    }
  }

  requirePostgresUrl(databaseUrl, issues);
  if (apiOrigin !== "" && apiOrigin !== PLAKK_PRODUCTION_IDENTITIES.api) {
    issues.push("PLAKK_API_ORIGIN must be the canonical production API origin.");
  }
  if (webOrigin !== "" && webOrigin !== PLAKK_PRODUCTION_IDENTITIES.web) {
    issues.push("PLAKK_WEB_ORIGIN must be the canonical production Web origin.");
  }
  if (workosApiKey !== "" && !workosApiKey.startsWith("sk_")) {
    issues.push("WORKOS_API_KEY has an invalid format.");
  }
  if (workosClientId !== "" && !workosClientId.startsWith("client_")) {
    issues.push("WORKOS_CLIENT_ID has an invalid format.");
  }
  if (env.POLAR_SERVER?.trim() !== "production") {
    issues.push("POLAR_SERVER must be production.");
  }

  if (issues.length > 0) throw new InvalidBackendProductionConfiguration(issues);

  return {
    apiOrigin: apiOrigin as typeof PLAKK_PRODUCTION_IDENTITIES.api,
    environment,
    release,
    webOrigin: webOrigin as typeof PLAKK_PRODUCTION_IDENTITIES.web,
  };
};

export const validateBackendProductionEnvironmentOnStartup = (): void => {
  if (process.env.NODE_ENV === "production") validateBackendProductionEnvironment(process.env);
};
