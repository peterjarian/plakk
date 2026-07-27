import "dotenv/config";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { DrizzleLive, PgClientLive, PostgresNotificationsLive } from "@plakk/db";
import { PlakkApi } from "@plakk/shared/PlakkApi";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { createServer } from "node:http";

import { AccountCapability, AccountTrialRepository } from "./account/AccountCapability.ts";
import { allowedBackendOrigins, InvalidCorsConfiguration } from "./cors.ts";
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

const AccountDomainLive = AccountCapability.layer.pipe(
  Layer.provideMerge(AccountTrialRepository.layer),
);

const RpcRoutes = RpcServer.layerHttp({
  group: PlakkApi,
  path: "/api/rpc",
  protocol: "http",
  disableFatalDefects: true,
}).pipe(
  Layer.provide(PlakkApiLive),
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(InternalServerErrorMiddlewareLive),
  Layer.provide(AccountDomainLive),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(InfrastructureLive),
);

const HealthRoute = HttpRouter.add(
  "GET",
  "/health",
  Effect.succeed(HttpServerResponse.text("ok")),
).pipe(HttpRouter.serve);

const CorsLive = Layer.unwrap(
  Effect.all({
    configuredWebOrigin: Config.option(Config.string("PLAKK_WEB_ORIGIN")).pipe(
      Effect.map(Option.getOrUndefined),
    ),
    nodeEnv: Config.string("NODE_ENV").pipe(Config.withDefault("development")),
  }).pipe(
    Effect.flatMap(({ configuredWebOrigin, nodeEnv }) =>
      Effect.try({
        try: () => allowedBackendOrigins(configuredWebOrigin, nodeEnv === "production"),
        catch: (cause) =>
          cause instanceof InvalidCorsConfiguration
            ? cause
            : new InvalidCorsConfiguration({
                cause,
                message: "Invalid backend CORS configuration.",
              }),
      }),
    ),
    Effect.orDie,
    Effect.map((allowedOrigins) =>
      HttpRouter.cors({
        allowedOrigins,
        allowedMethods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["authorization", "content-type"],
        maxAge: 86_400,
      }),
    ),
  ),
);

const BackendRoutes = Layer.mergeAll(HealthRoute, RpcRoutes, CorsLive);

const NodeServerLive = NodeHttpServer.layerConfig(createServer, {
  host: Config.string("PLAKK_BACKEND_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.int("PORT").pipe(Config.withDefault(3100)),
});

export const BackendLive = HttpRouter.serve(BackendRoutes).pipe(Layer.provide(NodeServerLive));

NodeRuntime.runMain(Layer.launch(BackendLive.pipe(Layer.provideMerge(TelemetryLive))));
