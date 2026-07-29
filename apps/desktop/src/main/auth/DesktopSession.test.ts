import { NodeFileSystem } from "@effect/platform-node";
import {
  Client,
  ContentStore,
  CurrentSession,
  OfflineError,
  SessionError,
  type ClientSnapshot,
} from "@plakk/client-runtime";
import type { User } from "@plakk/shared";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import { makeDesktopSqliteLayer } from "../Sqlite.ts";
import { DesktopContentStore } from "../snippets/DesktopContentStore.ts";
import { NativeFileSources } from "../snippets/NativeFileSources.ts";
import { AuthService } from "./AuthService.ts";
import {
  AuthServiceError,
  AuthSessionExpiredError,
  type AuthServiceFailure,
} from "./AuthService.ts";
import { DesktopSession, makeDesktopSessionLive } from "./DesktopSession.ts";

const firstUser: User = {
  id: "user_1",
  email: "user_1@example.com",
  firstName: "First",
  lastName: "User",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const secondUser: User = {
  ...firstUser,
  id: "user_2",
  email: "user_2@example.com",
};

const protocolLayer = RpcClient.layerProtocolHttp({ url: "http://localhost/api/rpc" }).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(RpcSerialization.layerNdjson),
);

describe("DesktopSession", () => {
  it.effect("owns one shared client across sign-in, account switching, and sign-out", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const accessTokens = new Map<string, Effect.Effect<string, OfflineError | SessionError>>();
      let cleanupOwner: User | null = null;
      let storedUser: User | null = firstUser;
      let sessionUser: User | null = firstUser;
      let sessionAccessToken = "fresh-token";
      let sessionFailure: AuthServiceFailure | null = null;

      const fakeClientLayer = Layer.effect(
        Client,
        Effect.acquireRelease(
          Effect.gen(function* () {
            const session = yield* CurrentSession;
            events.push(`activate:${session.user.id}`);
            accessTokens.set(session.user.id, session.accessToken);
            const snapshot: ClientSnapshot = {
              user: session.user,
              capability: {
                status: "OFFLINE",
                storageProvider: { known: false, value: null },
              },
              snippets: [],
              storageUsageBytes: 0,
              syncStatus: "CONNECTED",
            };
            return Client.of({
              subscribe: () => Stream.make(snapshot),
              refresh: Effect.void,
              clearLocalData: Effect.sync(() => void events.push(`purge:${session.user.id}`)),
              content: {
                download: () => Effect.void,
                read: () => Stream.empty,
                freeUp: Effect.succeed({
                  reclaimedBytes: 0,
                  removedCopies: 0,
                  storageUsageBytes: 0,
                }),
              },
              snippets: {
                delete: () => Effect.void,
                dismissFailedUpload: () => Effect.void,
              },
              uploads: { upload: () => Effect.void },
            });
          }),
          () =>
            CurrentSession.use((session) =>
              Effect.sync(() => void events.push(`deactivate:${session.user.id}`)),
            ),
        ),
      );

      const dependencies = Layer.mergeAll(
        Layer.succeed(
          AuthService,
          AuthService.of({
            callbackUrl: Effect.succeed("plakk-auth://callback"),
            cleanupOwner: Effect.sync(() => cleanupOwner),
            setCleanupOwner: (user) =>
              Effect.sync(() => {
                cleanupOwner = user;
              }),
            getStoredAccount: () => Effect.sync(() => storedUser),
            getSession: () =>
              sessionFailure === null
                ? Effect.sync(() =>
                    sessionUser === null
                      ? null
                      : { user: sessionUser, accessToken: sessionAccessToken },
                  )
                : Effect.fail(sessionFailure),
            handleCallbackUrl: () => {
              storedUser = secondUser;
              sessionUser = secondUser;
              sessionAccessToken = "second-token";
              return Effect.succeed({ user: secondUser, accessToken: "second-token" });
            },
            signOut: () =>
              Effect.sync(() => {
                cleanupOwner = null;
                storedUser = null;
                sessionUser = null;
                events.push("credentials:clear");
              }),
            startSignIn: () => Effect.succeed("https://example.com/sign-in"),
          }),
        ),
        Layer.succeed(
          NativeFileSources,
          NativeFileSources.of({
            register: () => Effect.succeed("source-id"),
            take: () => undefined,
            discardAll: () => [],
          }),
        ),
        Layer.succeed(
          DesktopContentStore,
          DesktopContentStore.of({
            forUser: () => ({
              store: ContentStore.of({
                entries: Effect.succeed([]),
                write: () => Effect.void,
                read: () => Stream.empty,
                readRange: () => Effect.succeed(new Uint8Array()),
                remove: () => Effect.void,
              }),
              preview: () => Effect.succeed(null),
            }),
          }),
        ),
        NodeFileSystem.layer,
        makeDesktopSqliteLayer(":memory:"),
        protocolLayer,
      );

      const result = yield* Effect.gen(function* () {
        const desktopSession = yield* DesktopSession;
        yield* desktopSession.start;
        yield* desktopSession.refresh;
        const firstToken = yield* accessTokens.get(firstUser.id)!;
        sessionAccessToken = "background-refreshed-token";
        const refreshedToken = yield* accessTokens.get(firstUser.id)!;

        sessionFailure = new AuthServiceError({
          cause: new TypeError("fetch failed"),
          message: "Could not refresh desktop auth credentials.",
        });
        yield* desktopSession.refresh;
        const offlineState = yield* desktopSession.current;

        sessionFailure = new AuthSessionExpiredError({
          cause: { status: 400 },
          message: "The desktop session is no longer valid.",
        });
        yield* desktopSession.refresh;
        const expiredState = yield* desktopSession.current;
        const expiredCommand = yield* desktopSession
          .withClient(() => Effect.void)
          .pipe(Effect.result);

        sessionFailure = null;
        yield* desktopSession.handleCallbackUrl("plakk-auth://callback");
        const secondToken = yield* accessTokens.get(secondUser.id)!;
        yield* desktopSession.signOut;
        return {
          command: yield* desktopSession.withClient(() => Effect.void).pipe(Effect.result),
          expiredCommand,
          expiredState,
          firstToken,
          offlineState,
          refreshedToken,
          secondToken,
          state: yield* desktopSession.current,
        };
      }).pipe(
        Effect.provide(makeDesktopSessionLive(fakeClientLayer).pipe(Layer.provide(dependencies))),
      );

      expect(result.firstToken).toBe("fresh-token");
      expect(result.refreshedToken).toBe("background-refreshed-token");
      expect(result.offlineState.user).toEqual(firstUser);
      expect(result.expiredState.user).toBeNull();
      expect(result.expiredCommand).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "SessionError" },
      });
      expect(result.secondToken).toBe("second-token");
      expect(result.state.user).toBeNull();
      expect(result.command).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "SessionError" },
      });
      expect(events).toEqual(
        expect.arrayContaining([
          `activate:${firstUser.id}`,
          `purge:${firstUser.id}`,
          `deactivate:${firstUser.id}`,
          `activate:${secondUser.id}`,
          `purge:${secondUser.id}`,
          `deactivate:${secondUser.id}`,
          "credentials:clear",
        ]),
      );
      expect(events.indexOf(`deactivate:${firstUser.id}`)).toBeLessThan(
        events.indexOf(`purge:${firstUser.id}`),
      );
      expect(events.lastIndexOf(`deactivate:${secondUser.id}`)).toBeLessThan(
        events.lastIndexOf(`purge:${secondUser.id}`),
      );
      expect(cleanupOwner).toBeNull();
    }),
  );
});
