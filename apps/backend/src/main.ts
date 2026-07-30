import "dotenv/config";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { DrizzleLive, PgClientLive, PostgresNotificationsLive } from "@plakk/db";
import { PlakkApi } from "@plakk/shared/PlakkApi";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { createServer } from "node:http";

import { AuthMiddlewareLive } from "./middleware/AuthMiddlewareLive.ts";
import { InternalServerErrorMiddlewareLive } from "./middleware/InternalServerErrorMiddlewareLive.ts";
import { PlakkApiLive } from "./rpcs/PlakkApiLive.ts";
import { StorageProviderLive } from "./storage/StorageProviderLive.ts";
import { TelemetryLive } from "./TelemetryLive.ts";

const InfrastructureLive = Layer.mergeAll(
  DrizzleLive,
  PgClientLive,
  PostgresNotificationsLive,
  StorageProviderLive,
).pipe(Layer.provideMerge(FetchHttpClient.layer));

const RpcRoutes = RpcServer.layerHttp({
  group: PlakkApi,
  path: "/api/rpc",
  protocol: "http",
  disableFatalDefects: true,
}).pipe(
  Layer.provide(PlakkApiLive),
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(InternalServerErrorMiddlewareLive),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(InfrastructureLive),
);

const HealthRoute = HttpRouter.add("GET", "/health", Effect.succeed(HttpServerResponse.text("ok")));

const webOrigin = Effect.runSync(
  Config.url("PLAKK_WEB_ORIGIN").pipe(
    Config.withDefault(new URL("http://localhost:3000")),
    Effect.orDie,
  ),
).origin;

const BackendRoutes = Layer.mergeAll(
  HealthRoute,
  RpcRoutes,
  HttpRouter.cors({
    allowedOrigins: ["plakk-app://renderer", webOrigin],
    allowedMethods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["authorization", "b3", "content-type", "traceparent"],
    maxAge: 86_400,
  }),
);

const NodeServerLive = NodeHttpServer.layerConfig(createServer, {
  host: Config.string("PLAKK_BACKEND_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.int("PORT").pipe(Config.withDefault(3100)),
});

export const BackendLive = HttpRouter.serve(BackendRoutes).pipe(Layer.provide(NodeServerLive));

NodeRuntime.runMain(Layer.launch(BackendLive.pipe(Layer.provideMerge(TelemetryLive))));
