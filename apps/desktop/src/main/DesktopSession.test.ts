import type { User } from "@plakk/shared";
import { NodeFileSystem } from "@effect/platform-node";
import { SnippetHydrationEngine } from "./Services/SnippetHydration.ts";
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

const account: User = {
  id: "user_1",
  email: "user_1@example.com",
  firstName: "Session",
  lastName: "Owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const secondAccount: User = {
  ...account,
  id: "user_2",
  email: "user_2@example.com",
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
      const transitionEvents: Array<string> = [];
      let credentialsPurged = false;
      let accountPurged = false;
      const purgedAccountIds: Array<string> = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(
          AuthService,
          AuthService.of({
            callbackUrl: Effect.succeed("plakk-auth://callback"),
            getStoredAccount: () => Effect.succeed(account),
            getSession: () => Deferred.await(pendingSession),
            handleCallbackUrl: (rawUrl) =>
              rawUrl === "plakk-auth://switch"
                ? Effect.succeed({ accessToken: "second-token", user: secondAccount })
                : Effect.gen(function* () {
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
            purge: (accountId) =>
              Effect.sync(() => {
                accountPurged = true;
                purgedAccountIds.push(accountId);
                transitionEvents.push("account-purged");
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
            owner: Effect.succeed({ account, cleanupPending: false }),
            refresh: Effect.void,
            update: (update) => Effect.sync(() => void localStateUpdates.push(update)),
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
            removeTombstones: () => Effect.void,
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
            snapshot: () =>
              Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => void transitionEvents.push("sync-stopped")),
                ),
              ),
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
        yield* Fiber.join(starting);
        localStateUpdates.length = 0;
        const signingOut = yield* session.signOut.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(pendingSession, { accessToken: "stale-token", user: account });
        yield* Fiber.join(signingOut);
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
        const accountAfterRaces = yield* session.currentAccount;
        const updateAfterRaces = localStateUpdates.at(-1);

        yield* session.handleCallbackUrl("plakk-auth://callback");
        yield* Effect.yieldNow;
        const purgesBeforeSwitch = purgedAccountIds.length;
        const transitionEventsBeforeSwitch = transitionEvents.length;
        yield* session.handleCallbackUrl("plakk-auth://switch");
        return {
          account: yield* session.currentAccount,
          accountAfterRaces,
          accountPurged,
          credentialEvents,
          credentialsPurged,
          localStateUpdates,
          refreshLocalStateUpdates,
          switchPurges: purgedAccountIds.slice(purgesBeforeSwitch),
          switchTransitionEvents: transitionEvents.slice(transitionEventsBeforeSwitch),
          updateAfterRaces,
        };
      }).pipe(
        Effect.provide(
          DesktopSessionLive.pipe(Layer.provide(Layer.merge(dependencies, NodeFileSystem.layer))),
        ),
      );

      expect(result.accountAfterRaces).toBeNull();
      expect(result.account).toMatchObject({ id: secondAccount.id });
      expect(result.accountPurged).toBe(true);
      expect(result.credentialsPurged).toBe(true);
      expect(result.refreshLocalStateUpdates).not.toContainEqual({ kind: "offline", account });
      expect(result.credentialEvents).toContain("credentials-purged");
      expect(result.updateAfterRaces).toEqual({ kind: "signed-out" });
      expect(result.switchPurges).toEqual([account.id]);
      expect(result.switchTransitionEvents.slice(0, 2)).toEqual(["sync-stopped", "account-purged"]);
      expect(result.localStateUpdates.slice(-4)).toEqual([
        { kind: "owner-cleanup-pending" },
        { kind: "signed-out" },
        { kind: "offline", account: secondAccount },
        {
          kind: "online",
          account: secondAccount,
          accountStatus: { canSync: false, storageProvider: null, blockedReasons: [] },
          connection: null,
        },
      ]);
    }),
  );
});
