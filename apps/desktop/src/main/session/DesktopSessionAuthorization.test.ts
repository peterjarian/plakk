import { NodeFileSystem } from "@effect/platform-node";
import type { User } from "@plakk/shared";
import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";

import { AuthService } from "../auth/AuthService.ts";
import { LocalState, LocalStateError, type LocalStateUpdate } from "../local-state/LocalState.ts";
import { PlakkRpcClient } from "../PlakkRpcClient.ts";
import { ManagedSnippetContent } from "../snippets/content/ManagedSnippetContent.ts";
import { SnippetHydrationEngine } from "../snippets/hydration/SnippetHydration.ts";
import {
  SnippetRemoteTransport,
  SnippetRemoteTransportError,
} from "../snippets/replica/SnippetRemoteTransport.ts";
import { SnippetReplica } from "../snippets/replica/SnippetReplica.ts";
import { NativeFileSources } from "../snippets/sources/NativeFileSources.ts";
import { SnippetUploadEngine } from "../snippets/upload/SnippetUploadEngine.ts";
import { DesktopAccountData, DesktopAccountPurgeError } from "./DesktopAccountData.ts";
import { DesktopSession, DesktopSessionCommandError } from "./DesktopSession.ts";
import { DesktopSessionLive } from "./DesktopSessionLive.ts";

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
  readonly getStoredAccount?: () => Effect.Effect<User | null>;
  readonly handleCallbackUrl?: (rawUrl: string) => Effect.Effect<{
    readonly accessToken: string;
    readonly user: User;
  } | null>;
  readonly purge: (accountId: string) => Effect.Effect<void, DesktopAccountPurgeError>;
  readonly localStateUpdates: Array<LocalStateUpdate>;
  readonly localStateOwner?: { readonly account: User; readonly cleanupPending: boolean };
  readonly updateLocalState?: (update: LocalStateUpdate) => Effect.Effect<void, LocalStateError>;
  readonly rpc?: PlakkRpcClient["Service"];
  readonly remote?: SnippetRemoteTransport["Service"];
  readonly signOut?: () => Effect.Effect<void>;
}) =>
  Layer.mergeAll(
    Layer.succeed(
      AuthService,
      AuthService.of({
        callbackUrl: Effect.succeed("plakk-auth://callback"),
        getStoredAccount: options.getStoredAccount ?? (() => Effect.succeed(firstAccount)),
        getSession: options.getSession,
        handleCallbackUrl: options.handleCallbackUrl ?? (() => Effect.succeed(null)),
        signOut: options.signOut ?? (() => Effect.void),
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
          liveConnection: null,
          storageUsageBytes: 0,
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
        discard: () => Effect.void,
        ingest: () => Effect.void,
        pause: Effect.void,
        purge: () => Effect.void,
        normalize: () => Effect.void,
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
      options.remote ??
        SnippetRemoteTransport.of({
          snapshot: () => Effect.never,
          invalidations: () => Stream.never,
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
      options.rpc ??
        PlakkRpcClient.of({
          GetAccountStatus: () =>
            Effect.succeed({ canSync: false, storageProvider: null, blockedReasons: [] }),
        } as never),
    ),
  );

describe("DesktopSession command authority", () => {
  it.effect(
    "refreshes credentials and restarts live invalidations after authentication failure",
    () =>
      Effect.gen(function* () {
        const reconnected = yield* Deferred.make<void>();
        const localStateUpdates: Array<LocalStateUpdate> = [];
        const connectionTokens: Array<string> = [];
        let sessionReads = 0;
        const layer = dependencies({
          getSession: () =>
            Effect.sync(() => ({
              accessToken: sessionReads++ === 0 ? "expired-token" : "fresh-token",
              user: firstAccount,
            })),
          localStateUpdates,
          purge: () => Effect.void,
          remote: SnippetRemoteTransport.of({
            snapshot: () => Effect.never,
            invalidations: ({ accessToken }) =>
              Stream.unwrap(
                Effect.sync(() => {
                  connectionTokens.push(accessToken);
                  return accessToken === "expired-token"
                    ? Stream.fail(
                        new SnippetRemoteTransportError({
                          cause: 401,
                          reason: "authentication interrupted",
                        }),
                      )
                    : Stream.fromEffect(Deferred.succeed(reconnected, undefined)).pipe(
                        Stream.map(() => undefined),
                        Stream.concat(Stream.never),
                      );
                }),
              ),
          }),
          rpc: PlakkRpcClient.of({
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
        });

        const current = yield* Effect.gen(function* () {
          const session = yield* DesktopSession;
          yield* session.start;
          yield* Deferred.await(reconnected);
          return yield* session.currentAccount;
        }).pipe(
          Effect.provide(
            DesktopSessionLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer))),
          ),
        );

        expect(connectionTokens).toEqual(["expired-token", "fresh-token"]);
        expect(current).toMatchObject({ accessToken: "fresh-token" });
      }),
  );

  it.effect("does not retry live invalidations while storage needs reauthorization", () =>
    Effect.gen(function* () {
      const capabilityChecked = yield* Deferred.make<void>();
      const localStateUpdates: Array<LocalStateUpdate> = [];
      let invalidationAttempts = 0;
      const layer = dependencies({
        getSession: () => Effect.succeed({ accessToken: "token", user: firstAccount }),
        localStateUpdates,
        purge: () => Effect.void,
        remote: SnippetRemoteTransport.of({
          snapshot: () => Effect.never,
          invalidations: () =>
            Stream.unwrap(
              Effect.sync(() => {
                invalidationAttempts += 1;
                return Stream.fail(
                  new SnippetRemoteTransportError({
                    cause: null,
                    reason: "storage is not connected",
                  }),
                );
              }),
            ),
        }),
        rpc: PlakkRpcClient.of({
          GetAccountStatus: () =>
            Effect.succeed({
              canSync: true,
              storageProvider: "GOOGLE_DRIVE",
              blockedReasons: [],
            }),
          GetPipeConnectionStatus: () =>
            Deferred.succeed(capabilityChecked, undefined).pipe(
              Effect.as({
                storageProvider: "GOOGLE_DRIVE",
                status: "NEEDS_REAUTHORIZATION",
                externalDestinationUrl: null,
              }),
            ),
        } as never),
      });

      const updates = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        yield* session.start;
        yield* Deferred.await(capabilityChecked);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("15 seconds");
        yield* Effect.yieldNow;
        return [...localStateUpdates];
      }).pipe(
        Effect.provide(
          DesktopSessionLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer))),
        ),
      );

      expect(invalidationAttempts).toBe(0);
      expect(updates).toContainEqual({
        kind: "online",
        account: firstAccount,
        accountStatus: {
          canSync: true,
          storageProvider: "GOOGLE_DRIVE",
          blockedReasons: [],
        },
        connection: {
          storageProvider: "GOOGLE_DRIVE",
          status: "NEEDS_REAUTHORIZATION",
          externalDestinationUrl: null,
        },
      });
      expect(updates).toContainEqual({
        kind: "live-connection",
        accountId: firstAccount.id,
        status: null,
      });
    }),
  );

  it.effect("keeps an active live connection stable across same-account token rotation", () =>
    Effect.gen(function* () {
      const connected = yield* Deferred.make<void>();
      const backgroundRefreshCompleted = yield* Deferred.make<void>();
      const localStateUpdates: Array<LocalStateUpdate> = [];
      let capabilityChecks = 0;
      let invalidationAttempts = 0;
      let sessionReads = 0;
      const layer = dependencies({
        getSession: () =>
          Effect.sync(() => ({
            accessToken: `token-${++sessionReads}`,
            user: firstAccount,
          })),
        localStateUpdates,
        purge: () => Effect.void,
        remote: SnippetRemoteTransport.of({
          snapshot: () => Effect.succeed([]),
          invalidations: () =>
            Stream.unwrap(
              Effect.sync(() => {
                invalidationAttempts += 1;
                return Stream.fromEffect(Deferred.succeed(connected, undefined)).pipe(
                  Stream.map(() => undefined),
                  Stream.concat(Stream.never),
                );
              }),
            ),
        }),
        rpc: PlakkRpcClient.of({
          GetAccountStatus: () =>
            Effect.gen(function* () {
              capabilityChecks += 1;
              if (capabilityChecks === 2) {
                yield* Deferred.succeed(backgroundRefreshCompleted, undefined);
              }
              return {
                canSync: true,
                storageProvider: "GOOGLE_DRIVE",
                blockedReasons: [],
              } as const;
            }),
          GetPipeConnectionStatus: () =>
            Effect.succeed({
              storageProvider: "GOOGLE_DRIVE",
              status: "CONNECTED",
              externalDestinationUrl: "https://drive.google.com/drive/folders/plakk",
            }),
        } as never),
      });

      const updates = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        yield* session.start;
        yield* Deferred.await(connected);
        yield* Deferred.await(backgroundRefreshCompleted);
        yield* Effect.yieldNow;
        localStateUpdates.length = 0;
        yield* session.refresh;
        yield* Effect.yieldNow;
        return [...localStateUpdates];
      }).pipe(
        Effect.provide(
          DesktopSessionLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer))),
        ),
      );

      expect(invalidationAttempts).toBe(1);
      expect(updates.some((update) => update.kind === "offline")).toBe(false);
      expect(updates.some((update) => update.kind === "live-connection")).toBe(false);
    }),
  );

  it.effect("revokes commands before sign-out cleanup and retains the purge owner for retry", () =>
    Effect.gen(function* () {
      const commandStarted = yield* Deferred.make<void>();
      const releaseCommand = yield* Deferred.make<void>();
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const purgeCalls: Array<string> = [];
      let signedOut = false;
      const layer = dependencies({
        getSession: () =>
          Effect.succeed(signedOut ? null : { accessToken: "token", user: firstAccount }),
        getStoredAccount: () => Effect.succeed(signedOut ? null : firstAccount),
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
        signOut: () => Effect.sync(() => void (signedOut = true)),
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
        getStoredAccount: () => Effect.succeed(secondAccount),
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
        {
          kind: "live-connection",
          accountId: firstAccount.id,
          status: null,
        },
        { kind: "owner-cleanup-pending" },
        { kind: "offline", account: secondAccount },
      ]);
    }),
  );

  it.effect("keeps a persisted cleanup owner unauthorized after restart", () =>
    Effect.gen(function* () {
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const purgeCalls: Array<string> = [];
      let signedOut = false;
      const layer = dependencies({
        getSession: () =>
          Effect.succeed(signedOut ? null : { accessToken: "token", user: firstAccount }),
        localStateOwner: { account: firstAccount, cleanupPending: true },
        localStateUpdates,
        purge: (accountId) => Effect.sync(() => void purgeCalls.push(accountId)),
        signOut: () => Effect.sync(() => void (signedOut = true)),
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

      expect(result.account).toBeNull();
      expect(result.command).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "DesktopSessionCommandError" },
      });
      expect(purgeCalls).toEqual([firstAccount.id]);
    }),
  );

  it.effect("does not block cached offline startup on a pending credential refresh", () =>
    Effect.gen(function* () {
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const layer = dependencies({
        getSession: () => Effect.never,
        getStoredAccount: () => Effect.succeed(firstAccount),
        localStateUpdates,
        purge: () => Effect.void,
      });

      const completed = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        const start = yield* session.start.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        return start.pollUnsafe();
      }).pipe(
        Effect.provide(
          DesktopSessionLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer))),
        ),
      );

      expect(completed).toBeDefined();
    }),
  );

  it.effect("serializes startup account reconciliation with an auth callback", () =>
    Effect.gen(function* () {
      const storedAccountRead = yield* Deferred.make<void>();
      const releaseStoredAccount = yield* Deferred.make<void>();
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const layer = dependencies({
        getSession: () => Effect.never,
        getStoredAccount: () =>
          Deferred.succeed(storedAccountRead, undefined).pipe(
            Effect.andThen(Deferred.await(releaseStoredAccount)),
            Effect.as(firstAccount),
          ),
        handleCallbackUrl: () =>
          Effect.succeed({ accessToken: "second-token", user: secondAccount }),
        localStateUpdates,
        purge: () => Effect.void,
      });

      const current = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        const starting = yield* session.start.pipe(Effect.forkChild);
        yield* Deferred.await(storedAccountRead);
        const callback = yield* session
          .handleCallbackUrl("plakk-auth://callback")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseStoredAccount, undefined);
        yield* Fiber.join(starting);
        yield* Fiber.join(callback);
        return yield* session.currentAccount;
      }).pipe(
        Effect.provide(
          DesktopSessionLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer))),
        ),
      );

      expect(current).toMatchObject({ id: secondAccount.id, accessToken: "second-token" });
    }),
  );

  it.effect("retries a persisted cleanup owner after the initial purge still fails", () =>
    Effect.gen(function* () {
      const localStateUpdates: Array<LocalStateUpdate> = [];
      const purgeCalls: Array<string> = [];
      let signedOut = false;
      const layer = dependencies({
        getSession: () => Effect.succeed(null),
        getStoredAccount: () => Effect.succeed(signedOut ? null : firstAccount),
        localStateOwner: { account: firstAccount, cleanupPending: true },
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
        signOut: () => Effect.sync(() => void (signedOut = true)),
      });

      const result = yield* Effect.gen(function* () {
        const session = yield* DesktopSession;
        const started = yield* session.start.pipe(Effect.result);
        yield* session.refresh;
        return { account: yield* session.currentAccount, started };
      }).pipe(
        Effect.provide(
          DesktopSessionLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer))),
        ),
        Effect.provide(TestClock.layer()),
      );

      expect(result.started._tag).toBe("Failure");
      expect(result.account).toBeNull();
      expect(purgeCalls).toEqual([firstAccount.id, firstAccount.id]);
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
      const sessionUpdates = localStateUpdates.filter(
        (update) => update.kind !== "live-connection",
      );
      expect(sessionUpdates.every((update) => update.kind === "offline")).toBe(true);
      expect(sessionUpdates.length).toBeGreaterThanOrEqual(2);
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
      const sessionUpdates = localStateUpdates.filter(
        (update) => update.kind !== "live-connection",
      );
      expect(sessionUpdates.length).toBeGreaterThanOrEqual(1);
      expect(sessionUpdates.every((update) => update.kind === "offline")).toBe(true);
    }),
  );
});
