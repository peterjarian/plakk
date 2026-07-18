import { RpcError } from "@plakk/shared/RpcError";
import {
  AuthMiddleware,
  CurrentUser,
  InternalServerErrorMiddleware,
  PlakkApi,
} from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { authenticateRequest } from "./auth/authenticateRequest.ts";
import { PlakkApiLive } from "./PlakkApiLive.ts";

const InternalServerErrorLive = Layer.succeed(InternalServerErrorMiddleware)(
  InternalServerErrorMiddleware.of((effect) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        Effect.gen(function* () {
          const traceId = yield* Effect.currentSpan.pipe(
            Effect.map((span) => span.traceId),
            Effect.orElseSucceed(() => "untraced"),
          );

          yield* Effect.logError("Unhandled RPC defect", { defect, traceId });

          return yield* new RpcError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Something went wrong. Please try again.",
            traceId,
          });
        }),
      ),
    ),
  ),
);

const AuthMiddlewareLive = Layer.succeed(AuthMiddleware)(
  AuthMiddleware.of((effect, { headers }) =>
    Effect.gen(function* () {
      const currentUser = yield* authenticateRequest(headers);
      return yield* Effect.provideService(effect, CurrentUser, currentUser);
    }),
  ),
);

export const RpcRoutes = RpcServer.layerHttp({
  group: PlakkApi,
  path: "/api/rpc",
  protocol: "http",
  disableFatalDefects: true,
}).pipe(
  Layer.provide(PlakkApiLive),
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(InternalServerErrorLive),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
);
