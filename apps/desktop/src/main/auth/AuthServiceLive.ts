import {
  createWorkOS,
  type AuthenticationResponse,
  type User as WorkOSUser,
} from "@workos-inc/node";
import type { User } from "@plakk/shared";
import { app } from "electron";
import { Clock, Config, Effect, Layer } from "effect";
import {
  accessTokenNeedsRefresh,
  AuthService,
  AuthServiceError,
  deriveDesktopAuthCallbackUrl,
  parseTrustedAuthCallbackUrl,
  type AuthSession,
  type AuthServiceFailure,
} from "./AuthService.ts";
import { AuthStore } from "./AuthStore.ts";

const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

export const AuthServiceLive = Layer.effect(
  AuthService,
  Effect.gen(function* () {
    const store = yield* AuthStore;
    const clientConfig = yield* Effect.cached(
      Effect.gen(function* () {
        const clientId = yield* Config.nonEmptyString("WORKOS_CLIENT_ID");
        const configuredCallbackUrl = yield* Config.url("WORKOS_REDIRECT_URI");
        const callbackUrl = deriveDesktopAuthCallbackUrl(configuredCallbackUrl, app.isPackaged);
        return { callbackUrl, clientId, workos: createWorkOS({ clientId }) };
      }),
    );

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
      ...(response.organizationId === undefined ? {} : { organizationId: response.organizationId }),
      refreshToken: response.refreshToken,
      user: userFromWorkOSUser(response.user),
    });

    const getValidCredentials = Effect.fn("AuthService.getValidCredentials")(function* () {
      const credentials = yield* readStoredCredentials();
      if (credentials === null) return null;

      const now = yield* Clock.currentTimeMillis;
      if (!(yield* accessTokenNeedsRefresh(credentials.accessToken, now))) return credentials;

      const { clientId, workos } = yield* clientConfig;
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
      callbackUrl: clientConfig.pipe(Effect.map(({ callbackUrl }) => callbackUrl.href)),
      getStoredAccount: Effect.fn("AuthService.getStoredAccount")(function* () {
        return (yield* readStoredCredentials())?.user ?? null;
      }),
      getSession,
      handleCallbackUrl: Effect.fn("AuthService.handleCallbackUrl")(function* (rawUrl: string) {
        if (!URL.canParse(rawUrl) || !["plakk:", "plakk-dev:"].includes(new URL(rawUrl).protocol)) {
          return null;
        }

        const { callbackUrl, clientId, workos } = yield* clientConfig;
        const url = parseTrustedAuthCallbackUrl(rawUrl, callbackUrl);
        if (url === null) return null;

        const storedPkce = yield* store
          .get("pkce")
          .pipe(Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })));
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
          .pipe(Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })));
        yield* store
          .set("credentials", credentials)
          .pipe(Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })));
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

        const { callbackUrl, clientId, workos } = yield* clientConfig;
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
          .pipe(Effect.mapError((cause) => new AuthServiceError({ cause, message: cause.reason })));

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
