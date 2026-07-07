import { RpcError } from "@plakk/shared/RpcError";
import { InternalServerErrorMiddleware, PlakkApi } from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { PlakkApiLive } from "./PlakkApiLive.ts";
import { ServerRuntimeLive } from "./ServerRuntime.ts";

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

const RpcRoutes = RpcServer.layerHttp({
  group: PlakkApi,
  path: "/api/rpc",
  protocol: "http",
  disableFatalDefects: true,
}).pipe(
  Layer.provide(PlakkApiLive),
  Layer.provide(ServerRuntimeLive),
  Layer.provide(InternalServerErrorLive),
  Layer.provide(RpcSerialization.layerNdjson),
);

export const { handler: handleRpcRequest } = HttpRouter.toWebHandler(RpcRoutes, {
  disableLogger: true,
});
