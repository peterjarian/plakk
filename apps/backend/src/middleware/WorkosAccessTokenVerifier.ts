import { RpcError } from "@plakk/shared/RpcError";
import { WorkOS } from "@workos-inc/node";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { jwtVerify } from "jose";

export class WorkosAccessTokenVerifier extends Context.Service<
  WorkosAccessTokenVerifier,
  {
    readonly verify: (accessToken: string) => Effect.Effect<{ readonly id: string }, RpcError>;
  }
>()("@plakk/backend/middleware/WorkosAccessTokenVerifier") {}

export const WorkosAccessTokenVerifierLive = Layer.effect(
  WorkosAccessTokenVerifier,
  Effect.gen(function* () {
    const clientId = yield* Config.nonEmptyString("WORKOS_CLIENT_ID").pipe(Effect.orDie);
    const workos = new WorkOS({ clientId });
    const jwks = yield* Effect.promise(() => workos.userManagement.getJWKS()).pipe(Effect.orDie);
    if (jwks === undefined) {
      return yield* Effect.die(new Error("WorkOS did not initialize its JWKS."));
    }

    return WorkosAccessTokenVerifier.of({
      verify: (accessToken) =>
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
    });
  }),
);
