import "dotenv/config";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { DrizzleLive, PgClientLive, PostgresNotificationsLive } from "@plakk/db";
import { PlakkApi } from "@plakk/shared/PlakkApi";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { createServer } from "node:http";

import { AccountCapability, AccountTrialRepository } from "./account/AccountCapability.ts";
import {
  AccountBilling,
  AccountBillingStateRepository,
  BillingAuthority,
} from "./billing/AccountBilling.ts";
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

const BillingDomainLive = AccountBilling.layer.pipe(
  Layer.provideMerge(AccountBillingStateRepository.layer),
  Layer.provideMerge(BillingAuthority.layer),
);

const AccountDomainLive = AccountCapability.layer.pipe(
  Layer.provideMerge(AccountTrialRepository.layer),
  Layer.provideMerge(BillingDomainLive),
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

const PolarWebhookRoute = HttpRouter.add(
  "POST",
  "/api/webhooks/polar",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text;
    const billing = yield* AccountBilling;
    return yield* billing.handleWebhook(body, request.headers).pipe(
      Effect.match({
        onFailure: (error) =>
          HttpServerResponse.empty({
            status: error._tag === "BillingWebhookVerificationError" ? 403 : 503,
          }),
        onSuccess: () => HttpServerResponse.empty({ status: 202 }),
      }),
    );
  }),
).pipe(HttpRouter.serve, Layer.provide(BillingDomainLive), Layer.provide(InfrastructureLive));

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

const BackendRoutes = Layer.mergeAll(HealthRoute, PolarWebhookRoute, RpcRoutes, CorsLive);

const NodeServerLive = NodeHttpServer.layerConfig(createServer, {
  host: Config.string("PLAKK_BACKEND_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.int("PORT").pipe(Config.withDefault(3100)),
});

export const BackendLive = HttpRouter.serve(BackendRoutes).pipe(Layer.provide(NodeServerLive));

NodeRuntime.runMain(Layer.launch(BackendLive.pipe(Layer.provideMerge(TelemetryLive))));
