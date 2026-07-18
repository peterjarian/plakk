import type { User } from "@plakk/shared";
import { RpcError } from "@plakk/shared/RpcError";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import { makeWorkOSClient } from "./makeWorkOSClient.ts";
import { userFromWorkOSAccessToken } from "./user.ts";

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
  }).pipe(Effect.orDie);
  const workos = yield* makeWorkOSClient(config.apiKey, config.clientId);
  const accessToken = bearerTokenFromHeader(headers.authorization);

  if (accessToken === null) {
    return yield* new RpcError({
      code: "UNAUTHENTICATED",
      message: "Sign in to continue.",
    });
  }
  const currentUser = yield* Effect.tryPromise({
    try: () =>
      userFromWorkOSAccessToken(accessToken, workos.userManagement.getJwksUrl(config.clientId)),
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
