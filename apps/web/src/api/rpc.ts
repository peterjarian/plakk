import { RpcError } from "@plakk/shared/RpcError";
import {
  AuthMiddleware,
  CurrentUser,
  InternalServerErrorMiddleware,
  PlakkApi,
} from "@plakk/shared/PlakkApi";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { makeAuthKitCoreClient } from "./auth/makeAuthKitCoreClient.ts";
import { makeWorkOSClient } from "./auth/makeWorkOSClient.ts";
import { userFromWorkOSAccessToken, userFromWorkOSUser } from "./auth/user.ts";
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

const bearerTokenFromHeader = (authorization: string | undefined) => {
  const [scheme, token] = authorization?.split(" ", 2) ?? [];
  return scheme?.toLowerCase() === "bearer" && token !== undefined && token !== "" ? token : null;
};

const AuthMiddlewareLive = Layer.succeed(AuthMiddleware)(
  AuthMiddleware.of((effect, { headers }) =>
    Effect.gen(function* () {
      const config = yield* Effect.all({
        apiKey: Config.string("WORKOS_API_KEY"),
        clientId: Config.string("WORKOS_CLIENT_ID"),
        redirectUri: Config.string("WORKOS_REDIRECT_URI"),
        cookiePassword: Config.string("WORKOS_COOKIE_PASSWORD"),
      }).pipe(
        Effect.mapError(
          () =>
            new RpcError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Authentication is not configured.",
            }),
        ),
      );
      const cookieName = yield* Config.string("WORKOS_COOKIE_NAME").pipe(
        Effect.orElseSucceed(() => "wos-session"),
      );
      const workos = yield* makeWorkOSClient(config.apiKey, config.clientId);
      const authKitCore = yield* makeAuthKitCoreClient(workos, { ...config, cookieName });
      const jwksUrl = workos.userManagement.getJwksUrl(config.clientId);
      const cookieHeader = headers.cookie;
      const accessToken = bearerTokenFromHeader(headers.authorization);

      const provideBearerUser = Effect.gen(function* () {
        if (accessToken === null) {
          return yield* new RpcError({
            code: "UNAUTHENTICATED",
            message: "Sign in to continue.",
          });
        }
        const currentUser = yield* Effect.tryPromise({
          try: () => userFromWorkOSAccessToken(accessToken, jwksUrl, authKitCore),
          catch: () =>
            new RpcError({
              code: "UNAUTHENTICATED",
              message: "Sign in to continue.",
            }),
        });
        if (currentUser === null) {
          return yield* new RpcError({
            code: "UNAUTHENTICATED",
            message: "Sign in to continue.",
          });
        }

        return yield* Effect.provideService(effect, CurrentUser, currentUser);
      });

      if (cookieHeader?.split(";").some((cookie) => cookie.trim().startsWith(`${cookieName}=`))) {
        const { user } = yield* Effect.promise(() => getAuth());

        if (user === null) {
          return yield* provideBearerUser;
        }

        return yield* Effect.provideService(effect, CurrentUser, userFromWorkOSUser(user));
      }

      return yield* provideBearerUser;
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
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(InternalServerErrorLive),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
);

export const { handler: handleRpcRequest } = HttpRouter.toWebHandler(RpcRoutes, {
  disableLogger: true,
});
