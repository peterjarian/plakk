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
) => `Authorization=Bearer ${Redacted.value(token)},${datasetHeader}=${dataset}`;

export default Alchemy.Stack(
  "Plakk",
  {
    providers: Layer.mergeAll(Axiom.providers(), Neon.providers(), Railway.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stack = yield* Stack;
    const workosApiKey = yield* Config.redacted("WORKOS_API_KEY");
    const workosClientId = yield* Config.string("WORKOS_CLIENT_ID");
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

    const traces = yield* Axiom.Dataset("Traces", {
      name: `plakk-${stack.stage}-traces`,
      kind: "otel:traces:v1",
      description: `Plakk ${stack.stage} traces`,
      retentionDays: 30,
      useRetentionPeriod: true,
    });
    const logs = yield* Axiom.Dataset("Logs", {
      name: `plakk-${stack.stage}-logs`,
      kind: "otel:logs:v1",
      description: `Plakk ${stack.stage} logs`,
      retentionDays: 30,
      useRetentionPeriod: true,
    });
    const metrics = yield* Axiom.Dataset("Metrics", {
      name: `plakk-${stack.stage}-metrics`,
      kind: "otel:metrics:v1",
      description: `Plakk ${stack.stage} metrics`,
      retentionDays: 30,
      useRetentionPeriod: true,
    });
    const ingestToken = yield* Axiom.ApiToken(
      "OtelIngestToken",
      Output.all(traces.name, logs.name, metrics.name).pipe(
        Output.map(([tracesName, logsName, metricsName]) => ({
          name: `plakk-${stack.stage}-otel-ingest`,
          description: `Ingest-only OTEL token for Plakk ${stack.stage}`,
          datasetCapabilities: {
            [tracesName]: { ingest: ["create"] as const },
            [logsName]: { ingest: ["create"] as const },
            [metricsName]: { ingest: ["create"] as const },
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
        WORKOS_API_KEY: workosApiKey,
        WORKOS_CLIENT_ID: workosClientId,
        OTEL_SERVICE_NAME: "plakk-backend",
        OTEL_RESOURCE_ATTRIBUTES: `deployment.environment.name=${stack.stage}`,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: traces.otelTracesEndpoint,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: logs.otelLogsEndpoint,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: metrics.otelMetricsEndpoint,
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: Output.all(ingestToken.token, traces.name).pipe(
          Output.map(([token, dataset]) => otelHeaders(token, dataset, "X-Axiom-Dataset")),
        ),
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: Output.all(ingestToken.token, logs.name).pipe(
          Output.map(([token, dataset]) => otelHeaders(token, dataset, "X-Axiom-Dataset")),
        ),
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: Output.all(ingestToken.token, metrics.name).pipe(
          Output.map(([token, dataset]) => otelHeaders(token, dataset, "X-Axiom-Metrics-Dataset")),
        ),
      },
    });

    return {
      backendUrl: backend.url,
      railwayProjectId: backend.projectId,
      neonProjectId: database.projectId,
      axiomDatasets: {
        traces: traces.name,
        logs: logs.name,
        metrics: metrics.name,
      },
    };
  }),
);
