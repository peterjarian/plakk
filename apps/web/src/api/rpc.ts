import { RpcError } from "@plakk/shared/RpcError";
import type { User } from "@plakk/shared";
import {
  AuthMiddleware,
  CurrentUser,
  InternalServerErrorMiddleware,
  PlakkApi,
} from "@plakk/shared/PlakkApi";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
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

const AuthLive = Layer.succeed(AuthMiddleware)(
  AuthMiddleware.of((effect) =>
    Effect.gen(function* () {
      const { user } = yield* Effect.promise(() => getAuth());

      if (user === null) {
        return yield* new RpcError({
          code: "UNAUTHENTICATED",
          message: "Sign in to continue.",
        });
      }

      const currentUser: User = {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };

      return yield* Effect.provideService(effect, CurrentUser, currentUser);
    }),
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
  Layer.provide(AuthLive),
  Layer.provide(InternalServerErrorLive),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
);

export const { handler: handleRpcRequest } = HttpRouter.toWebHandler(RpcRoutes, {
  disableLogger: true,
});
