import { AuthKitCore, sessionEncryption } from "@workos/authkit-session";
import type { WorkOS } from "@workos-inc/node";
import * as Effect from "effect/Effect";

type AuthKitCoreClientConfig = {
  readonly apiKey: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly cookieName: string;
  readonly cookiePassword: string;
};

export const makeAuthKitCoreClient = Effect.fn("makeAuthKitCoreClient")(
  (workos: WorkOS, config: AuthKitCoreClientConfig) =>
    Effect.succeed(
      new AuthKitCore(
        {
          apiHttps: true,
          apiKey: config.apiKey,
          clientId: config.clientId,
          cookieMaxAge: 34_560_000,
          cookieName: config.cookieName,
          cookiePassword: config.cookiePassword,
          redirectUri: config.redirectUri,
        },
        workos,
        sessionEncryption,
      ),
    ),
);
