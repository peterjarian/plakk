import type { User } from "@plakk/shared";
import { RpcError } from "@plakk/shared/RpcError";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import { makeAuthKitCoreClient } from "./makeAuthKitCoreClient.ts";
import { makeWorkOSClient } from "./makeWorkOSClient.ts";
import { userFromWorkOSAccessToken, userFromWorkOSUser } from "./user.ts";

const bearerTokenFromHeader = (authorization: string | undefined) => {
  const [scheme, token] = authorization?.split(" ", 2) ?? [];
  return scheme?.toLowerCase() === "bearer" && token !== undefined && token !== "" ? token : null;
};

export const authenticateRequest = Effect.fn("authenticateRequest")(function* (
  headers: Readonly<Record<string, string | undefined>>,
): Effect.fn.Return<User, RpcError> {
  const config = yield* Effect.all({
    apiKey: Config.string("WORKOS_API_KEY"),
    clientId: Config.string("WORKOS_CLIENT_ID"),
    redirectUri: Config.string("WORKOS_REDIRECT_URI"),
    cookiePassword: Config.string("WORKOS_COOKIE_PASSWORD"),
  }).pipe(Effect.orDie);
  const cookieName = yield* Config.string("WORKOS_COOKIE_NAME").pipe(
    Effect.orElseSucceed(() => "wos-session"),
  );
  const workos = yield* makeWorkOSClient(config.apiKey, config.clientId);
  const authKitCore = yield* makeAuthKitCoreClient(workos, { ...config, cookieName });
  const accessToken = bearerTokenFromHeader(headers.authorization);

  const bearerUser = Effect.gen(function* () {
    if (accessToken === null) {
      return yield* new RpcError({
        code: "UNAUTHENTICATED",
        message: "Sign in to continue.",
      });
    }
    const currentUser = yield* Effect.tryPromise({
      try: () =>
        userFromWorkOSAccessToken(
          accessToken,
          workos.userManagement.getJwksUrl(config.clientId),
          authKitCore,
        ),
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
    return currentUser;
  });

  if (headers.cookie?.split(";").some((cookie) => cookie.trim().startsWith(`${cookieName}=`))) {
    const { user } = yield* Effect.promise(() => getAuth());
    if (user !== null) return userFromWorkOSUser(user);
  }

  return yield* bearerUser;
});
