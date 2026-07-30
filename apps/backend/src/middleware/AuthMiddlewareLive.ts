import { AuthMiddleware, CurrentUser } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { WorkOS } from "@workos-inc/node";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { jwtVerify } from "jose";

const CurrentUserClaimsSchema = Schema.Struct({
  sub: Schema.String,
  email: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  first_name: Schema.optionalKey(Schema.String),
  last_name: Schema.optionalKey(Schema.String),
  plakk_free_until: Schema.optionalKey(Schema.DateTimeUtcFromString),
});

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

        const rawPayload = yield* Effect.tryPromise({
          try: async () => {
            const { payload } = await jwtVerify(accessToken, jwks);
            return payload;
          },
          catch: () =>
            new RpcError({
              code: "UNAUTHENTICATED",
              message: "Sign in to continue.",
            }),
        });
        const payload = yield* Schema.decodeUnknownEffect(CurrentUserClaimsSchema)(rawPayload).pipe(
          Effect.mapError(
            () =>
              new RpcError({
                code: "UNAUTHENTICATED",
                message: "Sign in to continue.",
              }),
          ),
        );
        const name =
          payload.name ?? [payload.first_name, payload.last_name].filter(Boolean).join(" ");
        const currentUser = {
          id: payload.sub,
          ...(payload.email === undefined ? {} : { email: payload.email }),
          ...(name === "" ? {} : { name }),
          ...(payload.plakk_free_until === undefined
            ? {}
            : { freeUntil: payload.plakk_free_until }),
          ...(headers.origin === undefined ? {} : { requestOrigin: headers.origin }),
        };
        return yield* Effect.provideService(effect, CurrentUser, currentUser);
      }),
    );
  }),
);
