import { AuthMiddleware, CurrentUser } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { WorkOS } from "@workos-inc/node";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { jwtVerify } from "jose";

import { AccountCapability } from "../account/AccountCapability.ts";

type AccessTokenVerifier = (accessToken: string) => Effect.Effect<CurrentUser["Service"], RpcError>;

export const runAuthenticatedRpc = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  authorization: string | undefined,
  verifyAccessToken: AccessTokenVerifier,
  accountCapability: AccountCapability["Service"],
): Effect.Effect<A, E | RpcError, Exclude<R, CurrentUser>> =>
  Effect.gen(function* () {
    const [scheme, accessToken] = authorization?.split(" ", 2) ?? [];
    if (scheme?.toLowerCase() !== "bearer" || accessToken === undefined || accessToken === "") {
      return yield* new RpcError({
        code: "UNAUTHENTICATED",
        message: "Sign in to continue.",
      });
    }

    const currentUser = yield* verifyAccessToken(accessToken);
    yield* accountCapability.startTrial(currentUser.id);
    return yield* Effect.provideService(effect, CurrentUser, currentUser);
  });

const makeAuthMiddleware = (
  verifyAccessToken: AccessTokenVerifier,
  accountCapability: AccountCapability["Service"],
): AuthMiddleware["Service"] =>
  AuthMiddleware.of((effect, { headers }) =>
    runAuthenticatedRpc(effect, headers.authorization, verifyAccessToken, accountCapability),
  );

export const AuthMiddlewareLive = Layer.effect(
  AuthMiddleware,
  Effect.gen(function* () {
    const accountCapability = yield* AccountCapability;
    const clientId = yield* Config.nonEmptyString("WORKOS_CLIENT_ID").pipe(Effect.orDie);
    const workos = new WorkOS({ clientId });
    const jwks = yield* Effect.promise(() => workos.userManagement.getJWKS()).pipe(Effect.orDie);
    if (jwks === undefined) {
      return yield* Effect.die(new Error("WorkOS did not initialize its JWKS."));
    }

    return makeAuthMiddleware(
      (accessToken) =>
        Effect.tryPromise({
          try: async () => {
            const { payload } = await jwtVerify(accessToken, jwks);
            if (typeof payload.sub !== "string") {
              throw new TypeError("WorkOS access token is missing its subject.");
            }
            return { id: payload.sub };
          },
          catch: () =>
            new RpcError({
              code: "UNAUTHENTICATED",
              message: "Sign in to continue.",
            }),
        }),
      accountCapability,
    );
  }),
);
