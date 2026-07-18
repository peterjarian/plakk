import type { User } from "@plakk/shared";
import { SnippetHydrationEngine } from "@plakk/shared/SnippetHydration";
import {
  ManagedSnippetContent,
  SnippetRemoteTransport,
  SnippetReplica,
} from "@plakk/shared/SnippetReplica";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";

import { AuthService } from "./auth/AuthService.ts";
import { DesktopSessionLive } from "./Layers/DesktopSession.ts";
import { PlakkRpcClient } from "./PlakkRpcClient.ts";
import { DesktopAccountData } from "./Services/DesktopAccountData.ts";
import { DesktopSession } from "./Services/DesktopSession.ts";
import { LocalState, type LocalStateUpdate } from "./Services/LocalState.ts";
import { NativeFileSources } from "./Services/NativeFileSources.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";
import { UserConfigStore } from "./UserConfigStore.ts";

const account: User = {
  id: "user_1",
  email: "user_1@example.com",
  firstName: "Session",
  lastName: "Owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("DesktopSession", () => {
  it.effect("cannot restore stale refresh or callback work after explicit sign-out starts", () =>
    Effect.gen(function* () {
      const pendingSession = yield* Deferred.make<{
        readonly accessToken: string;
        readonly user: User;
      } | null>();
      const pendingCallback = yield* Deferred.make<{
        readonly accessToken: string;
        readonly user: User;
      } | null>();
      const callbackStarted = yield* Deferred.make<void>();
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const credentialEvents: Array<string> = [];
      let credentialsPurged = false;
      let accountPurged = false;
      const dependencies = Layer.mergeAll(
        Layer.succeed(
          AuthService,
          AuthService.of({
            callbackUrl: Effect.succeed("plakk-auth://callback"),
            getSession: () => Deferred.await(pendingSession),
            handleCallbackUrl: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(callbackStarted, undefined);
                const session = yield* Deferred.await(pendingCallback);
                credentialEvents.push("callback-credentials-written");
                return session;
              }),
            signOut: () =>
              Effect.sync(() => {
                credentialsPurged = true;
                credentialEvents.push("credentials-purged");
              }),
            startSignIn: () => Effect.succeed("https://example.com/sign-in"),
          }),
        ),
        Layer.succeed(
          DesktopAccountData,
          DesktopAccountData.of({
            purge: () =>
              Effect.sync(() => {
                accountPurged = true;
                localStateUpdates.push({ kind: "signed-out" });
              }),
          }),
        ),
        Layer.succeed(
          LocalState,
          LocalState.of({
            changes: Stream.empty,
            current: Effect.succeed({
              revision: 0,
              account,
              provider: { known: true, value: "GOOGLE_DRIVE" },
              capability: { status: "OFFLINE" },
              snippets: [],
            }),
            refresh: Effect.void,
            update: (update) => Effect.sync(() => void localStateUpdates.push(update)),
          }),
        ),
        Layer.succeed(
          NativeFileSources,
          NativeFileSources.of({
            register: () => "source-id",
            take: () => undefined,
            discardAll: () => [],
          }),
        ),
        Layer.succeed(
          SnippetUploadEngine,
          SnippetUploadEngine.of({
            cancel: () => Effect.void,
            changes: Stream.empty,
            delete: () => Effect.void,
            discard: () => Effect.void,
            ingest: () => Effect.void,
            pause: Effect.void,
            project: () => Effect.succeed([]),
            purge: () => Effect.void,
            reconcile: () => Effect.void,
            resume: () => Effect.void,
            retry: () => Effect.void,
          }),
        ),
        Layer.succeed(
          SnippetHydrationEngine,
          SnippetHydrationEngine.of({
            changes: Stream.empty,
            download: () => Effect.void,
            pause: Effect.void,
            purge: () => Effect.void,
            reconcile: () => Effect.succeed(new Map()),
            resume: () => Effect.void,
            state: () => Effect.succeed({ status: "NOT_AVAILABLE" }),
            updateSettings: () => Effect.void,
          }),
        ),
        Layer.succeed(
          UserConfigStore,
          UserConfigStore.of({
            get: Effect.succeed({
              keepAllFilesOffline: false,
              showExternalLinkWarning: true,
            }),
            reset: Effect.die("unused"),
            set: () => Effect.die("unused"),
          }),
        ),
        Layer.succeed(
          SnippetReplica,
          SnippetReplica.of({
            changes: Stream.empty,
            commit: () => Effect.void,
            get: () => Effect.succeed(null),
            purge: () => Effect.void,
            remove: () => Effect.void,
          }),
        ),
        Layer.succeed(
          SnippetRemoteTransport,
          SnippetRemoteTransport.of({
            pull: () => Effect.never,
            snapshot: () => Effect.never,
            wakes: () => Stream.never,
          }),
        ),
        Layer.succeed(
          ManagedSnippetContent,
          ManagedSnippetContent.of({
            available: () => Effect.succeed(false),
            get: () => Effect.succeed(null),
            invalidate: () => Effect.void,
            putStream: () => Effect.void,
          }),
        ),
        Layer.succeed(
          PlakkRpcClient,
          PlakkRpcClient.of({
            GetAccountStatus: () =>
              Effect.succeed({ canSync: false, storageProvider: null, blockedReasons: [] }),
          } as never),
        ),
      );
      const result = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        const starting = yield* session.start.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const signingOut = yield* session.signOut.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(pendingSession, { accessToken: "stale-token", user: account });
        yield* Fiber.join(signingOut);
        yield* Fiber.interrupt(starting);
        const refreshLocalStateUpdates = [...localStateUpdates];

        const callback = yield* session
          .handleCallbackUrl("plakk-auth://callback")
          .pipe(Effect.forkChild);
        yield* Deferred.await(callbackStarted);
        const callbackSignOut = yield* session.signOut.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(pendingCallback, {
          accessToken: "callback-token",
          user: account,
        });
        yield* Fiber.join(callback);
        yield* Fiber.join(callbackSignOut);
        return {
          account: yield* session.currentAccount,
          accountPurged,
          credentialEvents,
          credentialsPurged,
          localStateUpdates,
          refreshLocalStateUpdates,
        };
      }).pipe(Effect.provide(DesktopSessionLive.pipe(Layer.provide(dependencies))));

      expect(result.account).toBeNull();
      expect(result.accountPurged).toBe(true);
      expect(result.credentialsPurged).toBe(true);
      expect(result.refreshLocalStateUpdates).not.toContainEqual({ kind: "offline", account });
      expect(result.credentialEvents.at(-1)).toBe("credentials-purged");
      expect(result.localStateUpdates.at(-1)).toEqual({ kind: "signed-out" });
    }),
  );
});
