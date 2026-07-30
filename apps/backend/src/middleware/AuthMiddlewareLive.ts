import { AuthMiddleware, CurrentUser } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { WorkOS } from "@workos-inc/node";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { jwtVerify } from "jose";

export const AuthMiddlewareLive = Layer.effect(
  AuthMiddleware,
  Effect.gen(function* () {
    const clientId = yield* Config.nonEmptyString("WORKOS_CLIENT_ID").pipe(Effect.orDie);
    const workos = new WorkOS({ clientId });
    const jwks = yield* Effect.promise(() => workos.userManagement.getJWKS()).pipe(Effect.orDie);
    if (jwks === undefined) {
      return yield* Effect.die(new Error("WorkOS did not initialize its JWKS."));
    }

    return AuthMiddleware.of((effect, { headers }) =>
      Effect.gen(function* () {
        const [scheme, accessToken] = headers.authorization?.split(" ", 2) ?? [];
        if (scheme?.toLowerCase() !== "bearer" || accessToken === undefined || accessToken === "") {
          return yield* new RpcError({
            code: "UNAUTHENTICATED",
            message: "Sign in to continue.",
          });
        }

        const currentUser = yield* Effect.tryPromise({
          try: async () => {
            const { payload } = await jwtVerify(accessToken, jwks);
            if (typeof payload.sub !== "string") {
              throw new TypeError("WorkOS access token is missing its subject.");
            }
            return {
              id: payload.sub,
              ...(headers.origin === undefined ? {} : { requestOrigin: headers.origin }),
            };
          },
          catch: () =>
            new RpcError({
              code: "UNAUTHENTICATED",
              message: "Sign in to continue.",
            }),
        });
        return yield* Effect.provideService(effect, CurrentUser, currentUser);
      }),
    );
  }),
);
