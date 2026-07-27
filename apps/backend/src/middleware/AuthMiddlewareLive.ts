import { AuthenticatedRpcRequest, AuthMiddleware, CurrentUser } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AccountCapability } from "../account/AccountCapability.ts";
import { WorkosAccessTokenVerifier } from "./WorkosAccessTokenVerifier.ts";

type AccessTokenVerifier = (
  accessToken: string,
) => Effect.Effect<{ readonly id: string }, RpcError>;

export const runAuthenticatedRpc = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  authorization: string | undefined,
  requestOrigin: string | undefined,
  verifyAccessToken: AccessTokenVerifier,
  accountCapability: AccountCapability["Service"],
): Effect.Effect<A, E | RpcError, Exclude<Exclude<R, CurrentUser>, AuthenticatedRpcRequest>> =>
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
    return yield* effect.pipe(
      Effect.provideService(CurrentUser, currentUser),
      Effect.provideService(AuthenticatedRpcRequest, { origin: requestOrigin ?? null }),
    );
  });

const makeAuthMiddleware = (
  verifyAccessToken: AccessTokenVerifier,
  accountCapability: AccountCapability["Service"],
): AuthMiddleware["Service"] =>
  AuthMiddleware.of((effect, { headers }) =>
    runAuthenticatedRpc(
      effect,
      headers.authorization,
      headers.origin,
      verifyAccessToken,
      accountCapability,
    ),
  );

export const AuthMiddlewareLive = Layer.effect(
  AuthMiddleware,
  Effect.gen(function* () {
    const accountCapability = yield* AccountCapability;
    const verifier = yield* WorkosAccessTokenVerifier;
    return makeAuthMiddleware(verifier.verify, accountCapability);
  }),
);
