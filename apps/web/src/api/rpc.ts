import { RpcError } from "@plakk/shared/RpcError";
import type { User } from "@plakk/shared";
import { AuthKitCore, sessionEncryption } from "@workos/authkit-session";
import {
  AuthMiddleware,
  CurrentUser,
  InternalServerErrorMiddleware,
  PlakkApi,
} from "@plakk/shared/PlakkApi";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import { WorkOS, type User as WorkOSUser } from "@workos-inc/node";
import * as Config from "effect/Config";
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

const userFromWorkOSUser = (user: WorkOSUser): User => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const hasCookie = (cookieHeader: string | undefined, name: string) =>
  cookieHeader?.split(";").some((cookie) => cookie.trim().startsWith(`${name}=`)) ?? false;

const bearerTokenFromHeader = (authorization: string | undefined) => {
  const [scheme, token] = authorization?.split(" ", 2) ?? [];
  return scheme?.toLowerCase() === "bearer" && token !== undefined && token !== "" ? token : null;
};

const unauthenticated = () =>
  new RpcError({
    code: "UNAUTHENTICATED",
    message: "Sign in to continue.",
  });

const getAuthKitCore = Effect.gen(function* () {
  const apiKey = yield* Config.string("WORKOS_API_KEY");
  const clientId = yield* Config.string("WORKOS_CLIENT_ID");
  const redirectUri = yield* Config.string("WORKOS_REDIRECT_URI");
  const cookiePassword = yield* Config.string("WORKOS_COOKIE_PASSWORD");
  const cookieName = yield* Config.string("WORKOS_COOKIE_NAME").pipe(
    Effect.orElseSucceed(() => "wos-session"),
  );

  const workos = new WorkOS({ apiKey, clientId });
  const core = new AuthKitCore(
    {
      apiHttps: true,
      apiKey,
      clientId,
      cookieMaxAge: 34_560_000,
      cookieName,
      cookiePassword,
      redirectUri,
    },
    workos,
    sessionEncryption,
  );

  return { core, cookieName, workos };
}).pipe(
  Effect.mapError(
    () =>
      new RpcError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Authentication is not configured.",
      }),
  ),
);

const AuthLive = Layer.succeed(AuthMiddleware)(
  AuthMiddleware.of((effect, { headers }) =>
    Effect.gen(function* () {
      const { core, cookieName, workos } = yield* getAuthKitCore;
      const cookieHeader = headers.cookie;
      const accessToken = bearerTokenFromHeader(headers.authorization);

      const provideBearerUser = Effect.gen(function* () {
        if (accessToken === null || !(yield* Effect.promise(() => core.verifyToken(accessToken)))) {
          return yield* unauthenticated();
        }

        const userId = core.parseTokenClaims(accessToken).sub;
        if (userId === undefined) {
          return yield* unauthenticated();
        }

        const currentUser = yield* Effect.tryPromise({
          try: () => workos.userManagement.getUser(userId),
          catch: () => unauthenticated(),
        }).pipe(Effect.map(userFromWorkOSUser));
        return yield* Effect.provideService(effect, CurrentUser, currentUser);
      });

      if (hasCookie(cookieHeader, cookieName)) {
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
  Layer.provide(AuthLive),
  Layer.provide(InternalServerErrorLive),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
);

export const { handler: handleRpcRequest } = HttpRouter.toWebHandler(RpcRoutes, {
  disableLogger: true,
});
