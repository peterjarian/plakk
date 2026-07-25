import "dotenv/config";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { PostgresNotificationsLive } from "@plakk/db";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { createServer } from "node:http";

import { RpcRoutes } from "./api/rpc.ts";
import { ServerRuntimeLive } from "./api/ServerRuntime.ts";
import { SnippetInvalidationsRoute } from "./api/snippets/snippetInvalidations.ts";
import { TelemetryLive } from "./TelemetryLive.ts";

const HealthRoute = HttpRouter.add(
  "GET",
  "/health",
  Effect.succeed(HttpServerResponse.text("ok")),
).pipe(HttpRouter.serve);

const BackendRoutes = Layer.mergeAll(
  HealthRoute,
  RpcRoutes.pipe(Layer.provide(ServerRuntimeLive)),
  SnippetInvalidationsRoute.pipe(Layer.provide(PostgresNotificationsLive)),
  HttpRouter.cors({
    allowedOrigins: ["plakk-app://renderer"],
    allowedMethods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type"],
    maxAge: 86_400,
  }),
);

const NodeServerLive = NodeHttpServer.layerConfig(createServer, {
  host: Config.string("PLAKK_BACKEND_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.int("PORT").pipe(Config.withDefault(3100)),
});

export const BackendLive = HttpRouter.serve(BackendRoutes).pipe(Layer.provide(NodeServerLive));

NodeRuntime.runMain(Layer.launch(BackendLive.pipe(Layer.provideMerge(TelemetryLive))));
