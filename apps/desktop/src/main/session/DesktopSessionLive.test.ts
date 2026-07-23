import type { User } from "@plakk/shared";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";

import { AuthService } from "../auth/AuthService.ts";
import { LocalState, type LocalStateUpdate } from "../local-state/LocalState.ts";
import { PlakkRpcClient } from "../PlakkRpcClient.ts";
import { ManagedSnippetContent } from "../snippets/content/ManagedSnippetContent.ts";
import { SnippetHydrationEngine } from "../snippets/hydration/SnippetHydration.ts";
import { SnippetRemoteTransport } from "../snippets/replica/SnippetRemoteTransport.ts";
import { SnippetReplica } from "../snippets/replica/SnippetReplica.ts";
import { NativeFileSources } from "../snippets/sources/NativeFileSources.ts";
import { SnippetUploadEngine } from "../snippets/upload/SnippetUploadEngine.ts";
import { DesktopAccountData } from "./DesktopAccountData.ts";
import { DesktopSession } from "./DesktopSession.ts";
import { DesktopSessionLive } from "./DesktopSessionLive.ts";

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
      const syncStarted = yield* Deferred.make<void>();
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const credentialEvents: Array<string> = [];
      const transitionEvents: Array<string> = [];
      const normalizedAccountIds: Array<string> = [];
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
              liveConnection: null,
              storageUsageBytes: 0,
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
            discard: () => Effect.void,
            ingest: () => Effect.void,
            pause: Effect.void,
            purge: () => Effect.void,
            normalize: (accountId) =>
              Effect.sync(() => {
                normalizedAccountIds.push(accountId);
              }),
          }),
        ),
        Layer.succeed(
          SnippetHydrationEngine,
          SnippetHydrationEngine.of({
            changes: Stream.empty,
            download: () => Effect.void,
            freeUpSpace: () => Effect.void,
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
            update: (_accountId, transform) => Effect.succeed(transform({ items: [] })),
            purge: () => Effect.void,
            remove: () => Effect.void,
          }),
        ),
        Layer.succeed(
          SnippetRemoteTransport,
          SnippetRemoteTransport.of({
            snapshot: () => Effect.never,
            invalidations: () =>
              Stream.fromEffect(Deferred.succeed(syncStarted, undefined)).pipe(
                Stream.map(() => undefined),
                Stream.concat(Stream.never),
                Stream.ensuring(Effect.sync(() => void transitionEvents.push("sync-stopped"))),
              ),
          }),
        ),
        Layer.succeed(
          ManagedSnippetContent,
          ManagedSnippetContent.of({
            available: () => Effect.succeed(false),
            get: () => Effect.succeed(null),
            invalidate: () => Effect.void,
            putStream: () => Effect.void,
          } as never),
        ),
        Layer.succeed(
          PlakkRpcClient,
          PlakkRpcClient.of({
            GetAccountStatus: () =>
              Effect.succeed({
                canSync: true,
                storageProvider: "GOOGLE_DRIVE",
                blockedReasons: [],
              }),
            GetPipeConnectionStatus: () =>
              Effect.succeed({
                storageProvider: "GOOGLE_DRIVE",
                status: "CONNECTED",
                externalDestinationUrl: "https://drive.google.com/drive/folders/plakk",
              }),
          } as never),
        ),
      );
      const result = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        const starting = yield* session.start.pipe(Effect.forkChild);
        yield* Fiber.join(starting);
        const normalizedAtStartup = [...normalizedAccountIds];
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
        yield* Deferred.await(syncStarted);
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
          normalizedAtStartup,
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
      expect(result.normalizedAtStartup).toEqual([account.id]);
      expect(result.refreshLocalStateUpdates).not.toContainEqual({ kind: "offline", account });
      expect(result.credentialEvents).toContain("credentials-purged");
      expect(result.updateAfterRaces).toEqual({ kind: "signed-out" });
      expect(result.switchPurges).toEqual([account.id]);
      expect(result.switchTransitionEvents.slice(0, 2)).toEqual(["sync-stopped", "account-purged"]);
      expect(
        result.localStateUpdates.filter((update) => update.kind !== "live-connection").slice(-4),
      ).toEqual([
        { kind: "owner-cleanup-pending" },
        { kind: "signed-out" },
        { kind: "offline", account: secondAccount },
        {
          kind: "online",
          account: secondAccount,
          accountStatus: {
            canSync: true,
            storageProvider: "GOOGLE_DRIVE",
            blockedReasons: [],
          },
          connection: {
            storageProvider: "GOOGLE_DRIVE",
            status: "CONNECTED",
            externalDestinationUrl: "https://drive.google.com/drive/folders/plakk",
          },
        },
      ]);
    }),
  );
});
