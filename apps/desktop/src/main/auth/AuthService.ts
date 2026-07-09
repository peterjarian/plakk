import {
  createWorkOS,
  type AuthenticationResponse,
  type User as WorkOSUser,
} from "@workos-inc/node";
import type { User } from "@plakk/shared";
import { app } from "electron";
import { Clock, Config, Context, Effect, Layer, Schema } from "effect";
import { AuthStore } from "./AuthStore.ts";

const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 60 * 1000;

const AccessTokenClaimsCodec = Schema.fromJsonString(Schema.Struct({ exp: Schema.Number }));

type AuthSession = {
  readonly accessToken: string;
  readonly user: User;
};
type AuthServiceFailure = AuthServiceError | Config.ConfigError;

export class AuthServiceError extends Schema.TaggedErrorClass<AuthServiceError>()(
  "AuthServiceError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

export function deriveDesktopAuthCallbackUrl(configuredUrl: URL, isPackaged: boolean): URL {
  const protocol = isPackaged ? "plakk:" : "plakk-dev:";
  return new URL(`${protocol}${configuredUrl.href.slice(configuredUrl.protocol.length)}`);
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
  const payload = accessToken.split(".")[1];
  if (payload === undefined) return true;

  return yield* Effect.try(() => Buffer.from(payload, "base64url").toString("utf8")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AccessTokenClaimsCodec)),
    Effect.map((claims) => claims.exp * 1000 - now <= ACCESS_TOKEN_REFRESH_WINDOW_MS),
    Effect.catch(() => Effect.succeed(true)),
  );
});

export class AuthService extends Context.Service<
  AuthService,
  {
    readonly callbackUrl: string;
    getSession(): Effect.Effect<AuthSession | null, AuthServiceFailure>;
    handleCallbackUrl(rawUrl: string): Effect.Effect<AuthSession | null, AuthServiceFailure>;
    startSignIn(): Effect.Effect<string, AuthServiceFailure>;
    signOut(): Effect.Effect<void, AuthServiceError>;
  }
>()("plakk/main/auth/AuthService") {
  static readonly layer = Layer.effect(
    AuthService,
    Effect.gen(function* () {
      const store = yield* AuthStore;
      const clientId = yield* Config.nonEmptyString("WORKOS_CLIENT_ID");
      const configuredCallbackUrl = yield* Config.url("WORKOS_REDIRECT_URI");
      const callbackUrl = deriveDesktopAuthCallbackUrl(configuredCallbackUrl, app.isPackaged);
      const workos = createWorkOS({ clientId });

      const readStoredCredentials = Effect.fn("AuthService.readStoredCredentials")(function* () {
        const isEncryptionAvailable = yield* store.isEncryptionAvailable;

        if (!isEncryptionAvailable) {
          return yield* new AuthServiceError({
            cause: null,
            message: "Secure credential storage is unavailable.",
          });
        }

        const stored = yield* store
          .get("credentials")
          .pipe(Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })));
        return stored;
      });

      const userFromWorkOSUser = (user: WorkOSUser): User => ({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });

      const credentialsFromAuthenticationResponse = (response: AuthenticationResponse) => ({
        accessToken: response.accessToken,
        ...(response.organizationId === undefined
          ? {}
          : { organizationId: response.organizationId }),
        refreshToken: response.refreshToken,
        user: userFromWorkOSUser(response.user),
      });

      const getValidCredentials = Effect.fn("AuthService.getValidCredentials")(function* () {
        const credentials = yield* readStoredCredentials();
        if (credentials === null) return null;

        const now = yield* Clock.currentTimeMillis;
        if (!(yield* accessTokenNeedsRefresh(credentials.accessToken, now))) return credentials;

        const response = yield* Effect.tryPromise({
          try: () =>
            workos.userManagement.authenticateWithRefreshToken({
              clientId,
              ...(credentials.organizationId === undefined
                ? {}
                : { organizationId: credentials.organizationId }),
              refreshToken: credentials.refreshToken,
            }),
          catch: (cause) =>
            new AuthServiceError({
              cause,
              message: "Could not refresh desktop auth credentials.",
            }),
        });

        const nextCredentials = credentialsFromAuthenticationResponse(response);
        yield* store
          .set("credentials", nextCredentials)
          .pipe(Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })));
        return nextCredentials;
      });

      const getSession = Effect.fn("AuthService.getSession")(function* (): Effect.fn.Return<
        AuthSession | null,
        AuthServiceFailure
      > {
        const credentials = yield* getValidCredentials();
        return credentials === null
          ? null
          : { accessToken: credentials.accessToken, user: credentials.user };
      });

      return AuthService.of({
        callbackUrl: callbackUrl.href,
        getSession,
        handleCallbackUrl: Effect.fn("AuthService.handleCallbackUrl")(function* (rawUrl: string) {
          const url = parseTrustedAuthCallbackUrl(rawUrl, callbackUrl);
          if (url === null) return null;

          const storedPkce = yield* store
            .get("pkce")
            .pipe(
              Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })),
            );
          if (storedPkce === null) {
            return yield* new AuthServiceError({
              cause: null,
              message: "No desktop sign-in request is pending.",
            });
          }

          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const now = yield* Clock.currentTimeMillis;

          if (code === null || state !== storedPkce.state || storedPkce.expiresAt < now) {
            yield* store
              .set("pkce", null)
              .pipe(
                Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })),
              );
            return yield* new AuthServiceError({
              cause: null,
              message: "Desktop sign-in callback is invalid or expired.",
            });
          }

          const response = yield* Effect.tryPromise({
            try: () =>
              workos.userManagement.authenticateWithCode({
                clientId,
                code,
                codeVerifier: storedPkce.codeVerifier,
              }),
            catch: (cause) =>
              new AuthServiceError({
                cause,
                message: "Could not exchange desktop auth callback code.",
              }),
          });

          const credentials = credentialsFromAuthenticationResponse(response);

          yield* store
            .set("pkce", null)
            .pipe(
              Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })),
            );
          yield* store
            .set("credentials", credentials)
            .pipe(
              Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })),
            );
          return { accessToken: credentials.accessToken, user: credentials.user };
        }),
        startSignIn: Effect.fn("AuthService.startSignIn")(function* () {
          const isEncryptionAvailable = yield* store.isEncryptionAvailable;
          if (!isEncryptionAvailable) {
            return yield* new AuthServiceError({
              cause: null,
              message: "Secure credential storage is unavailable.",
            });
          }

          const now = yield* Clock.currentTimeMillis;
          const request = yield* Effect.tryPromise({
            try: () =>
              workos.userManagement.getAuthorizationUrlWithPKCE({
                clientId,
                provider: "authkit",
                redirectUri: callbackUrl.href,
              }),
            catch: (cause) =>
              new AuthServiceError({ cause, message: "Could not start desktop sign-in." }),
          });

          yield* store
            .set("pkce", {
              codeVerifier: request.codeVerifier,
              expiresAt: now + AUTH_REQUEST_TTL_MS,
              state: request.state,
            })
            .pipe(
              Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })),
            );

          return request.url;
        }),
        signOut: Effect.fn("AuthService.signOut")(function* () {
          yield* store.clear.pipe(
            Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })),
          );
        }),
      });
    }),
  );
}
