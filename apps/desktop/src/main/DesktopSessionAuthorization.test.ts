import { NodeFileSystem } from "@effect/platform-node";
import type { User } from "@plakk/shared";
import { RpcError } from "@plakk/shared/RpcError";
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
import { DesktopAccountData, DesktopAccountPurgeError } from "./Services/DesktopAccountData.ts";
import { DesktopSession, DesktopSessionCommandError } from "./Services/DesktopSession.ts";
import { LocalState, LocalStateError, type LocalStateUpdate } from "./Services/LocalState.ts";
import { NativeFileSources } from "./Services/NativeFileSources.ts";
import { SnippetHydrationEngine } from "./Services/SnippetHydration.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";

const firstAccount: User = {
  id: "user_1",
  email: "user_1@example.com",
  firstName: "First",
  lastName: "Account",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const secondAccount: User = {
  ...firstAccount,
  id: "user_2",
  email: "user_2@example.com",
  firstName: "Second",
};

const dependencies = (options: {
  readonly getSession: () => Effect.Effect<{
    readonly accessToken: string;
    readonly user: User;
  } | null>;
  readonly purge: (accountId: string) => Effect.Effect<void, DesktopAccountPurgeError>;
  readonly localStateUpdates: Array<LocalStateUpdate>;
  readonly localStateOwner?: { readonly account: User; readonly cleanupPending: boolean };
  readonly updateLocalState?: (update: LocalStateUpdate) => Effect.Effect<void, LocalStateError>;
  readonly rpc?: PlakkRpcClient["Service"];
}) =>
  Layer.mergeAll(
    Layer.succeed(
      AuthService,
      AuthService.of({
        callbackUrl: Effect.succeed("plakk-auth://callback"),
        getSession: options.getSession,
        handleCallbackUrl: () => Effect.succeed(null),
        signOut: () => Effect.void,
        startSignIn: () => Effect.succeed("https://example.com/sign-in"),
      }),
    ),
    Layer.succeed(DesktopAccountData, DesktopAccountData.of({ purge: options.purge })),
    Layer.succeed(
      LocalState,
      LocalState.of({
        changes: Stream.empty,
        current: Effect.succeed({
          revision: 1,
          account: firstAccount,
          provider: { known: true, value: "GOOGLE_DRIVE" },
          capability: { status: "OFFLINE" },
          snippets: [],
        }),
        owner: Effect.succeed(
          options.localStateOwner ?? { account: firstAccount, cleanupPending: false },
        ),
        refresh: Effect.void,
        update: (update) => {
          options.localStateUpdates.push(update);
          return options.updateLocalState?.(update) ?? Effect.void;
        },
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
      options.rpc ??
        PlakkRpcClient.of({
          GetAccountStatus: () =>
            Effect.succeed({ canSync: false, storageProvider: null, blockedReasons: [] }),
        } as never),
    ),
  );

describe("DesktopSession command authority", () => {
  it.effect("revokes commands before sign-out cleanup and retains the purge owner for retry", () =>
    Effect.gen(function* () {
      const commandStarted = yield* Deferred.make<void>();
      const releaseCommand = yield* Deferred.make<void>();
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const purgeCalls: Array<string> = [];
      const layer = dependencies({
        getSession: () => Effect.succeed({ accessToken: "token", user: firstAccount }),
        localStateUpdates,
        purge: (accountId) =>
          Effect.gen(function* () {
            purgeCalls.push(accountId);
            if (purgeCalls.length === 1) {
              return yield* new DesktopAccountPurgeError({
                failures: [{ owner: "managed content", cause: "simulated failure" }],
              });
            }
          }),
      });

      const result = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        yield* session.start;
        const command = yield* session
          .withCurrentAccount(() =>
            Deferred.succeed(commandStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCommand)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(commandStarted);

        const firstSignOut = yield* session.signOut.pipe(Effect.result, Effect.forkChild);
        yield* Effect.yieldNow;
        const denied = yield* session
          .withCurrentAccount(() => Effect.void)
          .pipe(Effect.result, Effect.forkChild);
        const duringSignOut = yield* session.currentAccount;
        const purgesBeforeRelease = [...purgeCalls];

        yield* Deferred.succeed(releaseCommand, undefined);
        yield* Fiber.join(command);
        const firstResult = yield* Fiber.join(firstSignOut);
        const deniedResult = yield* Fiber.join(denied);
        const afterFailure = yield* session.currentAccount;
        yield* session.refresh;
        const deniedAfterRefresh = yield* session
          .withCurrentAccount(() => Effect.void)
          .pipe(Effect.result);
        yield* session.signOut;

        return {
          afterFailure,
          denied: deniedResult,
          deniedAfterRefresh,
          duringSignOut,
          firstResult,
          purgesBeforeRelease,
        };
      }).pipe(
        Effect.provide(
          DesktopSessionLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer))),
        ),
      );

      expect(result.duringSignOut).toMatchObject({ id: firstAccount.id, accessToken: null });
      expect(result.denied).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "DesktopSessionCommandError" },
      });
      expect(result.purgesBeforeRelease).toEqual([]);
      expect(result.firstResult._tag).toBe("Failure");
      expect(result.afterFailure).toMatchObject({ id: firstAccount.id, accessToken: null });
      expect(result.deniedAfterRefresh).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "DesktopSessionCommandError" },
      });
      expect(purgeCalls).toEqual([firstAccount.id, firstAccount.id]);
      expect(new DesktopSessionCommandError({ reason: "test" })._tag).toBe(
        "DesktopSessionCommandError",
      );
    }),
  );

  it.effect("fails closed when restart reconciliation cannot materialize the stored account", () =>
    Effect.gen(function* () {
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const layer = dependencies({
        getSession: () => Effect.succeed({ accessToken: "second-token", user: secondAccount }),
        localStateUpdates,
        purge: () => Effect.void,
        updateLocalState: (update) =>
          update.kind === "offline" && update.account.id === secondAccount.id
            ? Effect.fail(
                new LocalStateError({
                  cause: null,
                  reason: "simulated materialization failure",
                }),
              )
            : Effect.void,
      });

      const result = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        const started = yield* session.start.pipe(Effect.exit);
        const command = yield* session.withCurrentAccount(() => Effect.void).pipe(Effect.exit);
        return { account: yield* session.currentAccount, command, started };
      }).pipe(
        Effect.provide(
          DesktopSessionLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer))),
        ),
      );

      expect(result.started._tag).toBe("Failure");
      expect(result.account).toBeNull();
      expect(result.command._tag).toBe("Failure");
      expect(localStateUpdates).toEqual([
        { kind: "owner-cleanup-pending" },
        { kind: "offline", account: secondAccount },
      ]);
    }),
  );

  it.effect("keeps a persisted cleanup owner unauthorized after restart", () =>
    Effect.gen(function* () {
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const layer = dependencies({
        getSession: () => Effect.succeed({ accessToken: "token", user: firstAccount }),
        localStateOwner: { account: firstAccount, cleanupPending: true },
        localStateUpdates,
        purge: () => Effect.void,
      });

      const result = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        yield* session.start;
        return {
          account: yield* session.currentAccount,
          command: yield* session.withCurrentAccount(() => Effect.void).pipe(Effect.result),
        };
      }).pipe(
        Effect.provide(
          DesktopSessionLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer))),
        ),
      );

      expect(result.account).toMatchObject({ id: firstAccount.id, accessToken: "token" });
      expect(result.command).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "DesktopSessionCommandError" },
      });
      expect(localStateUpdates).toEqual([]);
    }),
  );

  it.effect("publishes offline capability when linked-provider detail refresh fails", () =>
    Effect.gen(function* () {
      const detailAttempted = yield* Deferred.make<void>();
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const layer = dependencies({
        getSession: () => Effect.succeed({ accessToken: "token", user: firstAccount }),
        localStateUpdates,
        purge: () => Effect.void,
        rpc: PlakkRpcClient.of({
          GetAccountStatus: () =>
            Effect.succeed({
              canSync: true,
              storageProvider: "GOOGLE_DRIVE",
              blockedReasons: [],
            }),
          GetPipeConnectionStatus: () =>
            Deferred.succeed(detailAttempted, undefined).pipe(
              Effect.andThen(
                Effect.fail(
                  new RpcError({
                    code: "INTERNAL_SERVER_ERROR",
                    message: "simulated provider detail failure",
                  }),
                ),
              ),
            ),
        } as never),
      });

      const current = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        yield* session.start;
        yield* Deferred.await(detailAttempted);
        yield* Effect.yieldNow;
        return yield* session.currentAccount;
      }).pipe(
        Effect.provide(
          DesktopSessionLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer))),
        ),
      );

      expect(current).toMatchObject({ id: firstAccount.id, accessToken: "token" });
      expect(localStateUpdates).toHaveLength(2);
      expect(localStateUpdates.every((update) => update.kind === "offline")).toBe(true);
    }),
  );

  it.effect("does not block cached offline startup on an unavailable capability RPC", () =>
    Effect.gen(function* () {
      const capabilityStarted = yield* Deferred.make<void>();
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const layer = dependencies({
        getSession: () => Effect.succeed({ accessToken: "token", user: firstAccount }),
        localStateUpdates,
        purge: () => Effect.void,
        rpc: PlakkRpcClient.of({
          GetAccountStatus: () =>
            Deferred.succeed(capabilityStarted, undefined).pipe(Effect.andThen(Effect.never)),
        } as never),
      });

      const completed = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        const start = yield* session.start.pipe(Effect.forkChild);
        yield* Deferred.await(capabilityStarted);
        yield* Effect.yieldNow;
        return start.pollUnsafe();
      }).pipe(
        Effect.provide(
          DesktopSessionLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer))),
        ),
      );

      expect(completed).toBeDefined();
      expect(localStateUpdates).toEqual([{ kind: "offline", account: firstAccount }]);
    }),
  );
});
