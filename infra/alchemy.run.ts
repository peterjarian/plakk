import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Neon from "alchemy/Neon";
import * as Output from "alchemy/Output";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as Railway from "./src/railway/index.ts";

const buildCommand = "corepack pnpm --filter @plakk/backend build";
const startCommand = "corepack pnpm --filter @plakk/backend start";

const otelHeaders = (
  token: Axiom.ApiToken["Attributes"]["token"],
  dataset: string,
  datasetHeader: "X-Axiom-Dataset" | "X-Axiom-Metrics-Dataset",
): Redacted.Redacted<string> =>
  Redacted.make(`Authorization=Bearer ${Redacted.value(token)},${datasetHeader}=${dataset}`);

export default Alchemy.Stack(
  "Plakk",
  {
    providers: Layer.mergeAll(Axiom.providers(), Neon.providers(), Railway.providers),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stack = yield* Stack;
    const workosApiKey = yield* Config.redacted("WORKOS_API_KEY");
    const workosClientId = yield* Config.string("WORKOS_CLIENT_ID");
    const polarAccessToken = yield* Config.redacted("POLAR_ACCESS_TOKEN");
    const polarEnvironment = yield* Config.string("POLAR_ENVIRONMENT");
    const polarProductId = yield* Config.string("POLAR_PRODUCT_ID");
    const redisUrl = yield* Config.redacted("REDIS_URL");
    const repository = yield* Config.string("RAILWAY_REPOSITORY").pipe(
      Config.withDefault("peterjarian/plakk"),
    );
    const branch = yield* Config.string("RAILWAY_BRANCH").pipe(Config.withDefault("main"));
    const workspaceId = yield* Config.option(Config.string("RAILWAY_WORKSPACE_ID")).pipe(
      Effect.map(Option.getOrUndefined),
    );

    const database = yield* Neon.Project("Database", {
      name: `plakk-${stack.stage}`,
      region: "aws-eu-central-1",
      pgVersion: 17,
      databaseName: "plakk",
      migrationsDir: "../packages/db/drizzle",
    });

    const telemetry = yield* Axiom.Dataset("Telemetry", {
      name: `plakk-${stack.stage}-otel`,
      kind: "axiom:events:v1",
      description: `Plakk ${stack.stage} OpenTelemetry`,
      retentionDays: 30,
      useRetentionPeriod: true,
    });
    const ingestToken = yield* Axiom.ApiToken(
      "OtelIngestToken",
      telemetry.name.pipe(
        Output.map((datasetName) => ({
          name: `plakk-${stack.stage}-otel-ingest`,
          description: `Ingest-only OTEL token for Plakk ${stack.stage}`,
          datasetCapabilities: {
            [datasetName]: { ingest: ["create"] as const },
          },
        })),
      ),
    );

    const backend = yield* Railway.Backend("Backend", {
      projectName: `plakk-${stack.stage}`,
      serviceName: "backend",
      repository,
      branch,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      buildCommand,
      startCommand,
      healthcheckPath: "/health",
      watchPatterns: [
        "/apps/backend/**",
        "/packages/db/**",
        "/packages/shared/**",
        "/package.json",
        "/pnpm-lock.yaml",
        "/pnpm-workspace.yaml",
        "/tsconfig.base.json",
      ],
      variables: {
        DATABASE_URL: database.pooledConnectionUri,
        NODE_ENV: "production",
        PLAKK_BACKEND_HOST: "0.0.0.0",
        PLAKK_WEB_ORIGIN: "https://app.plakk.io",
        POLAR_ACCESS_TOKEN: polarAccessToken,
        POLAR_ENVIRONMENT: polarEnvironment,
        POLAR_PRODUCT_ID: polarProductId,
        REDIS_URL: redisUrl,
        WORKOS_API_KEY: workosApiKey,
        WORKOS_CLIENT_ID: workosClientId,
        OTEL_SERVICE_NAME: "plakk-backend",
        OTEL_RESOURCE_ATTRIBUTES: `deployment.environment.name=${stack.stage}`,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: telemetry.otelTracesEndpoint,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: telemetry.otelLogsEndpoint,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: telemetry.otelMetricsEndpoint,
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: Output.all(ingestToken.token, telemetry.name).pipe(
          Output.map(([token, dataset]) => otelHeaders(token, dataset, "X-Axiom-Dataset")),
        ),
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: Output.all(ingestToken.token, telemetry.name).pipe(
          Output.map(([token, dataset]) => otelHeaders(token, dataset, "X-Axiom-Dataset")),
        ),
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: Output.all(ingestToken.token, telemetry.name).pipe(
          Output.map(([token, dataset]) => otelHeaders(token, dataset, "X-Axiom-Metrics-Dataset")),
        ),
      },
    });

    return {
      backendUrl: backend.url,
      railwayProjectId: backend.projectId,
      neonProjectId: database.projectId,
      axiomDataset: telemetry.name,
    };
  }),
);
