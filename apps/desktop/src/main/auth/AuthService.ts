import type { User } from "@plakk/shared";
import { Config, Context, Effect, Schema } from "effect";

const ACCESS_TOKEN_REFRESH_WINDOW_MS = 60 * 1000;
const AccessTokenClaimsCodec = Schema.fromJsonString(Schema.Struct({ exp: Schema.Number }));

export type AuthSession = {
  readonly accessToken: string;
  readonly user: User;
};

export type AuthServiceFailure = AuthServiceError | AuthSessionExpiredError | Config.ConfigError;

export class AuthServiceError extends Schema.TaggedErrorClass<AuthServiceError>()(
  "AuthServiceError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

export class AuthSessionExpiredError extends Schema.TaggedErrorClass<AuthSessionExpiredError>()(
  "AuthSessionExpiredError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/**
 * A client-side or transient server failure cannot prove that the session is
 * invalid. Only explicit authentication responses should expire it.
 */
export function authRefreshFailureExpiresSession(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("status" in cause)) return false;
  const status = cause.status;
  return status === 400 || status === 401;
}

export function desktopAuthCallbackUrl(isPackaged: boolean): URL {
  const protocol = isPackaged ? "plakk:" : "plakk-dev:";
  return new URL(`${protocol}//auth/callback`);
}

export function parseTrustedAuthCallbackUrl(rawUrl: string, callbackUrl: URL): URL | null {
  if (!URL.canParse(rawUrl)) return null;

  const url = new URL(rawUrl);
  return url.protocol === callbackUrl.protocol &&
    url.username === callbackUrl.username &&
    url.password === callbackUrl.password &&
    url.host === callbackUrl.host &&
    url.pathname === callbackUrl.pathname
    ? url
    : null;
}

export const accessTokenNeedsRefresh = Effect.fn("AuthService.accessTokenNeedsRefresh")(function* (
  accessToken: string,
  now: number,
) {
  const segments = accessToken.split(".");
  if (
    segments.length !== 3 ||
    segments.some((segment) => segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment))
  ) {
    return true;
  }

  const payload = segments[1]!;
  return yield* Effect.try(() => Buffer.from(payload, "base64url").toString("utf8")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AccessTokenClaimsCodec)),
    Effect.map((claims) => claims.exp * 1000 - now <= ACCESS_TOKEN_REFRESH_WINDOW_MS),
    Effect.catch(() => Effect.succeed(true)),
  );
});

export class AuthService extends Context.Service<
  AuthService,
  {
    readonly callbackUrl: Effect.Effect<string, Config.ConfigError>;
    /** Returns the account whose local data must be cleared before activation. */
    readonly cleanupOwner: Effect.Effect<User | null, AuthServiceError>;
    /** Persists or clears the account owner for crash-safe local cleanup. */
    readonly setCleanupOwner: (user: User | null) => Effect.Effect<void, AuthServiceError>;
    getStoredAccount(): Effect.Effect<User | null, AuthServiceError>;
    getSession(): Effect.Effect<AuthSession | null, AuthServiceFailure>;
    handleCallbackUrl(rawUrl: string): Effect.Effect<AuthSession | null, AuthServiceFailure>;
    startSignIn(): Effect.Effect<string, AuthServiceFailure>;
    signOut(): Effect.Effect<void, AuthServiceError>;
  }
>()("plakk/main/auth/AuthService") {}
