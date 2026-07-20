import type { User } from "@plakk/shared";
import { accountCanSyncWithConnection } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import {
  Effect,
  Fiber,
  FileSystem,
  Layer,
  PubSub,
  Ref,
  Result,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import { AuthService, type AuthSession } from "../auth/AuthService.ts";
import { LocalState } from "../local-state/LocalState.ts";
import { PlakkRpcClient } from "../PlakkRpcClient.ts";
import { ManagedSnippetContent } from "../snippets/content/ManagedSnippetContent.ts";
import { SnippetHydrationEngine } from "../snippets/hydration/SnippetHydration.ts";
import { SnippetRemoteTransport } from "../snippets/replica/SnippetRemoteTransport.ts";
import { SnippetReplica } from "../snippets/replica/SnippetReplica.ts";
import { runSnippetReplicaSync } from "../snippets/replica/sync.ts";
import { NativeFileSources } from "../snippets/sources/NativeFileSources.ts";
import { SnippetUploadEngine } from "../snippets/upload/SnippetUploadEngine.ts";
import { DesktopAccountData } from "./DesktopAccountData.ts";
import {
  DesktopSession,
  DesktopSessionCommandError,
  DesktopSessionSignOutError,
  type DesktopSessionAccount,
  type DesktopSessionShape,
  type DesktopSessionTransitionError,
} from "./DesktopSession.ts";

type SessionStatus = {
  readonly accessToken: string | null;
  readonly user: User | null;
  readonly commandsAuthorized: boolean;
  readonly cleanupPending: boolean;
};

const statusFrom = (session: AuthSession | null): SessionStatus => ({
  accessToken: session?.accessToken ?? null,
  user: session?.user ?? null,
  commandsAuthorized: session !== null,
  cleanupPending: false,
});

const makeDesktopSession = Effect.gen(function* () {
  const auth = yield* AuthService;
  const accountData = yield* DesktopAccountData;
  const localState = yield* LocalState;
  const files = yield* NativeFileSources;
  const uploads = yield* SnippetUploadEngine;
  const hydration = yield* SnippetHydrationEngine;
  const replica = yield* SnippetReplica;
  const remote = yield* SnippetRemoteTransport;
  const managedContent = yield* ManagedSnippetContent;
  const rpc = yield* PlakkRpcClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const status = yield* Ref.make<SessionStatus>({
    accessToken: null,
    user: null,
    commandsAuthorized: false,
    cleanupPending: false,
  });
  const generation = yield* Ref.make(0);
  const started = yield* Ref.make(false);
  const syncFiber = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const capabilityFiber = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);
  const connectionRefresh = yield* Ref.make<Effect.Effect<void, DesktopSessionTransitionError>>(
    Effect.void,
  );
  const refreshLock = yield* Semaphore.make(1);
  const commandLock = yield* Semaphore.make(1);
  const issues = yield* PubSub.unbounded<string>();

  const publishIssue = Effect.fn("DesktopSession.publishIssue")(function* (message: string) {
    yield* PubSub.publish(issues, message);
  });
  const clearFileSources = Effect.suspend(() =>
    Effect.forEach(
      files.discardAll(),
      (temporaryPath) =>
        fileSystem
          .remove(temporaryPath, { force: true })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not remove a temporary native file source", { cause }),
            ),
          ),
      { discard: true },
    ),
  );
  const pauseAccountWork = Effect.all([uploads.pause, hydration.pause], { discard: true });
  const normalizeUploads = (accountId: string) =>
    uploads
      .normalize(accountId)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not normalize interrupted local uploads", { cause }).pipe(
            Effect.andThen(publishIssue("Could not restore interrupted local uploads.")),
          ),
        ),
      );
  const stopSync = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(syncFiber, null);
    if (fiber !== null) yield* Fiber.interrupt(fiber);
    const current = yield* Ref.get(status);
    if (current.user !== null) {
      yield* localState
        .update({
          kind: "live-connection",
          accountId: current.user.id,
          status: "RECONNECTING",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Could not publish stopped live connection status", { cause }),
          ),
        );
    }
  });
  const refreshSessionDetached = (failureMessage: string) =>
    Ref.get(connectionRefresh).pipe(
      Effect.flatten,
      Effect.catchCause((cause) => Effect.logError(failureMessage, { cause })),
      Effect.forkDetach,
      Effect.asVoid,
    );
  const startSync = Effect.fn("DesktopSession.startSync")(function* (session: AuthSession) {
    const fiber = yield* runSnippetReplicaSync(
      {
        id: session.user.id,
        accessToken: session.accessToken,
      },
      {
        onConnectionStatus: (liveStatus) =>
          localState
            .update({
              kind: "live-connection",
              accountId: session.user.id,
              status: liveStatus,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Could not publish live connection status", { cause }),
              ),
            ),
        onConnected: refreshSessionDetached("Could not refresh the reconnected desktop session"),
        onDisconnected: refreshSessionDetached(
          "Could not refresh credentials after live disconnection",
        ),
      },
    ).pipe(
      Effect.provideService(SnippetReplica, replica),
      Effect.provideService(SnippetRemoteTransport, remote),
      Effect.provideService(ManagedSnippetContent, managedContent),
      Effect.forkDetach,
    );
    yield* Ref.set(syncFiber, fiber);
    yield* Effect.yieldNow;
  });

  const setStatus = Effect.fn("DesktopSession.setStatus")(function* (next: SessionStatus) {
    const previous = yield* Ref.get(status);
    const accountChanged = previous.user?.id !== next.user?.id;
    const changed = previous.accessToken !== next.accessToken || accountChanged;
    if (accountChanged) {
      yield* Ref.update(generation, (value) => value + 1);
      yield* Ref.set(status, {
        ...previous,
        accessToken: null,
        commandsAuthorized: false,
        cleanupPending: previous.user !== null,
      });
      yield* commandLock.withPermit(
        Effect.gen(function* () {
          yield* stopSync;
          yield* pauseAccountWork;
          yield* clearFileSources;
          yield* localState.update({ kind: "owner-cleanup-pending" });
          if (previous.user !== null) {
            yield* accountData.purge(previous.user.id);
            yield* Ref.set(status, {
              accessToken: null,
              user: null,
              commandsAuthorized: false,
              cleanupPending: false,
            });
          }
          if (next.user !== null) {
            yield* localState.update({ kind: "offline", account: next.user });
            yield* normalizeUploads(next.user.id);
          }
          yield* Ref.set(status, next);
        }),
      );
    } else {
      if (changed) {
        yield* Ref.update(generation, (value) => value + 1);
        yield* stopSync;
        yield* hydration.pause;
      }
      if (next.user !== null && !next.cleanupPending) {
        yield* localState.update({ kind: "offline", account: next.user });
      }
      yield* Ref.set(status, next);
    }
    if (!changed) return;
    if (next.user !== null && next.accessToken !== null && next.commandsAuthorized) {
      yield* startSync({ user: next.user, accessToken: next.accessToken });
    }
  });

  const resumeBackgroundWork = Effect.fn("DesktopSession.resumeBackgroundWork")(function* (
    session: AuthSession,
  ) {
    yield* hydration
      .resume({ id: session.user.id, accessToken: session.accessToken })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not resume offline snippet downloads", { cause }).pipe(
            Effect.andThen(publishIssue("Could not resume offline snippet downloads.")),
          ),
        ),
      );
  });

  const refreshCapability = Effect.fn("DesktopSession.refreshCapability")(function* () {
    const current = yield* Ref.get(status);
    if (current.user === null || current.accessToken === null || !current.commandsAuthorized)
      return;
    const checkedGeneration = yield* Ref.get(generation);
    const headers = { authorization: `Bearer ${current.accessToken}` };
    const result = yield* Effect.gen(function* () {
      const account = yield* rpc.GetAccountStatus(undefined, { headers });
      const connection =
        account.storageProvider === null
          ? null
          : yield* rpc.GetPipeConnectionStatus(
              { storageProvider: account.storageProvider },
              { headers },
            );
      return { account, connection };
    }).pipe(Effect.scoped, Effect.result);
    const latest = yield* Ref.get(status);
    if (
      checkedGeneration !== (yield* Ref.get(generation)) ||
      latest.accessToken !== current.accessToken
    ) {
      return;
    }
    if (Result.isFailure(result)) {
      yield* hydration.pause;
      if (Schema.is(RpcError)(result.failure) && result.failure.code === "UNAUTHENTICATED") {
        yield* setStatus({
          accessToken: null,
          user: current.user,
          commandsAuthorized: current.commandsAuthorized,
          cleanupPending: current.cleanupPending,
        });
      } else {
        yield* localState
          .update({ kind: "offline", account: current.user })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Could not publish offline desktop capability", { cause }),
            ),
          );
      }
      return;
    }
    const { account, connection } = result.success;
    yield* localState
      .update({
        kind: "online",
        account: current.user,
        accountStatus: account,
        connection,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not confirm the local state capability", { cause }),
        ),
      );
    if (accountCanSyncWithConnection(account, connection)) {
      yield* resumeBackgroundWork({ user: current.user, accessToken: current.accessToken });
    } else {
      yield* hydration.pause;
    }
  });

  const reconcileCredentials = Effect.fn("DesktopSession.reconcileCredentials")(function* () {
    const checkedGeneration = yield* Ref.get(generation);
    const current = yield* Ref.get(status);
    const session = yield* auth.getSession().pipe(Effect.result);
    if (checkedGeneration !== (yield* Ref.get(generation))) return;
    const refreshed =
      Result.isSuccess(session) && session.success !== null ? statusFrom(session.success) : null;
    yield* setStatus(
      refreshed !== null
        ? current.cleanupPending && refreshed.user?.id === current.user?.id
          ? { ...refreshed, commandsAuthorized: false, cleanupPending: true }
          : refreshed
        : {
            accessToken: null,
            user: current.user,
            commandsAuthorized: !current.cleanupPending && current.user !== null,
            cleanupPending: current.cleanupPending,
          },
    );
  });

  const reconcileStoredAccount = Effect.fn("DesktopSession.reconcileStoredAccount")(function* () {
    let storedAccount = yield* auth.getStoredAccount();
    const current = yield* Ref.get(status);
    const cleanupAccount = current.user;

    if (current.cleanupPending && cleanupAccount !== null) {
      if (storedAccount?.id === cleanupAccount.id) {
        yield* auth.signOut();
        storedAccount = null;
      }
      yield* commandLock.withPermit(
        Effect.gen(function* () {
          yield* accountData.purge(cleanupAccount.id);
          yield* Ref.set(status, {
            accessToken: null,
            user: null,
            commandsAuthorized: false,
            cleanupPending: false,
          });
        }),
      );
    }

    yield* setStatus({
      accessToken: null,
      user: storedAccount,
      commandsAuthorized: false,
      cleanupPending: false,
    });
  });

  const refresh = refreshLock.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(status);
      if (current.cleanupPending) yield* reconcileStoredAccount();
      yield* reconcileCredentials();
      yield* refreshCapability();
    }),
  );
  yield* Ref.set(connectionRefresh, refresh);

  const handleCallbackUrl = (rawUrl: string) =>
    refreshLock.withPermit(
      Effect.gen(function* () {
        const session = yield* auth.handleCallbackUrl(rawUrl);
        if (session !== null) {
          yield* setStatus(statusFrom(session));
          yield* refreshCapability();
        }
        return session;
      }),
    );

  const signOut = Effect.gen(function* () {
    yield* Ref.update(generation, (value) => value + 1);
    yield* Ref.update(status, (current) => ({
      ...current,
      accessToken: null,
      commandsAuthorized: false,
      cleanupPending: current.user !== null,
    }));
    return yield* refreshLock.withPermit(
      commandLock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(status);
          yield* localState.update({ kind: "owner-cleanup-pending" }).pipe(
            Effect.mapError(
              (cause) =>
                new DesktopSessionSignOutError({
                  cause,
                  reason: "Could not retain the local cleanup owner.",
                }),
            ),
          );
          yield* stopSync;
          yield* pauseAccountWork;
          const localCleanup: Effect.Effect<void, unknown> =
            current.user === null
              ? localState.update({ kind: "signed-out" })
              : accountData.purge(current.user.id);
          const localResult = yield* Effect.result(localCleanup);
          const credentialResult = yield* Effect.result(auth.signOut());
          yield* clearFileSources;
          if (Result.isSuccess(localResult) && Result.isSuccess(credentialResult)) {
            yield* Ref.set(status, {
              accessToken: null,
              user: null,
              commandsAuthorized: false,
              cleanupPending: false,
            });
            return;
          }
          if (Result.isFailure(localResult)) {
            return yield* new DesktopSessionSignOutError({
              cause: localResult.failure,
              reason: "Could not purge all local account data.",
            });
          }
          if (Result.isFailure(credentialResult)) {
            return yield* new DesktopSessionSignOutError({
              cause: credentialResult.failure,
              reason: "Could not clear desktop credentials.",
            });
          }
        }),
      ),
    );
  });

  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) return;
    const cached = yield* localState.owner;
    if (cached !== null) {
      yield* Ref.set(status, {
        accessToken: null,
        user: cached.account,
        commandsAuthorized: false,
        cleanupPending: cached.cleanupPending,
      });
      if (!cached.cleanupPending) yield* normalizeUploads(cached.account.id);
    }
    const storedAccount = yield* Effect.result(refreshLock.withPermit(reconcileStoredAccount()));
    if (Result.isFailure(storedAccount)) {
      const current = yield* Ref.get(status);
      if (current.user !== null && !current.cleanupPending) {
        yield* Ref.set(status, {
          ...current,
          accessToken: null,
          commandsAuthorized: false,
          cleanupPending: true,
        });
        yield* localState.update({ kind: "owner-cleanup-pending" });
      }
      return yield* storedAccount.failure;
    }
    const capability = yield* refresh.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Could not refresh the initial desktop session", { cause }).pipe(
          Effect.andThen(publishIssue("Could not refresh the desktop session.")),
        ),
      ),
      Effect.forkDetach,
    );
    yield* Ref.set(capabilityFiber, capability);
  });

  const withCurrentAccount: DesktopSessionShape["withCurrentAccount"] = Effect.fn(
    "DesktopSession.withCurrentAccount",
  )(function* <A, E>(command: (account: DesktopSessionAccount) => Effect.Effect<A, E>) {
    return yield* commandLock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(status);
        if (current.user === null || !current.commandsAuthorized) {
          return yield* new DesktopSessionCommandError({
            reason: "The desktop account is not ready for commands.",
          });
        }
        return yield* command({ id: current.user.id, accessToken: current.accessToken });
      }),
    );
  });

  yield* Effect.addFinalizer(() =>
    Effect.all(
      [
        Ref.get(syncFiber).pipe(
          Effect.flatMap((fiber) => (fiber === null ? Effect.void : Fiber.interrupt(fiber))),
        ),
        Ref.get(capabilityFiber).pipe(
          Effect.flatMap((fiber) => (fiber === null ? Effect.void : Fiber.interrupt(fiber))),
        ),
      ],
      { discard: true },
    ),
  );

  return {
    currentAccount: Ref.get(status).pipe(
      Effect.map((current) =>
        current.user === null ? null : { id: current.user.id, accessToken: current.accessToken },
      ),
    ),
    issues: Stream.fromPubSub(issues),
    handleCallbackUrl,
    refresh,
    signOut,
    start,
    withCurrentAccount,
  } satisfies DesktopSessionShape;
});

export const DesktopSessionLive = Layer.effect(DesktopSession, makeDesktopSession);
