import type { User } from "@plakk/shared";
import { accountCanSyncWithConnection } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import {
  ManagedSnippetContent,
  runSnippetReplicaSync,
  SnippetRemoteTransport,
  SnippetReplica,
} from "@plakk/shared/SnippetReplica";
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
import { PlakkRpcClient } from "../PlakkRpcClient.ts";
import { DesktopAccountData } from "../Services/DesktopAccountData.ts";
import type { DesktopAccountPurgeError } from "../Services/DesktopAccountData.ts";
import {
  DesktopSession,
  DesktopSessionSignOutError,
  type DesktopSessionShape,
} from "../Services/DesktopSession.ts";
import { LocalState } from "../Services/LocalState.ts";
import { NativeFileSources } from "../Services/NativeFileSources.ts";
import { SnippetHydrationEngine } from "../Services/SnippetHydration.ts";
import { SnippetUploadEngine } from "../SnippetUploadEngine.ts";

type SessionStatus = { readonly accessToken: string | null; readonly user: User | null };

const statusFrom = (session: AuthSession | null): SessionStatus => ({
  accessToken: session?.accessToken ?? null,
  user: session?.user ?? null,
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
  const status = yield* Ref.make<SessionStatus>({ accessToken: null, user: null });
  const generation = yield* Ref.make(0);
  const started = yield* Ref.make(false);
  const syncFiber = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const refreshFiber = yield* Ref.make<Fiber.Fiber<void, DesktopAccountPurgeError> | null>(null);
  const refreshLock = yield* Semaphore.make(1);
  const issues = yield* PubSub.unbounded<string>();

  const publishIssue = (message: string) => PubSub.publish(issues, message);
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
  const pauseBackgroundWork = Effect.all([uploads.pause, hydration.pause], { discard: true });
  const stopSync = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(syncFiber, null);
    if (fiber !== null) yield* Fiber.interrupt(fiber);
  });
  const startSync = Effect.fn("DesktopSession.startSync")(function* (session: AuthSession) {
    const fiber = yield* runSnippetReplicaSync({
      id: session.user.id,
      accessToken: session.accessToken,
    }).pipe(
      Effect.provideService(SnippetReplica, replica),
      Effect.provideService(SnippetRemoteTransport, remote),
      Effect.provideService(ManagedSnippetContent, managedContent),
      Effect.forkDetach,
    );
    yield* Ref.set(syncFiber, fiber);
  });

  const setStatus = Effect.fn("DesktopSession.setStatus")(function* (next: SessionStatus) {
    const previous = yield* Ref.get(status);
    const accountChanged = previous.user?.id !== next.user?.id;
    const changed = previous.accessToken !== next.accessToken || accountChanged;
    if (changed) {
      yield* Ref.update(generation, (value) => value + 1);
      yield* stopSync;
      yield* pauseBackgroundWork;
    }
    if (accountChanged) yield* clearFileSources;
    if (previous.user !== null && next.user !== null && accountChanged) {
      yield* accountData.purge(previous.user.id);
    }
    yield* Ref.set(status, next);
    if (next.user !== null) {
      yield* localState
        .update({ kind: "offline", account: next.user })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Could not update the cached desktop account", { cause }),
          ),
        );
    }
    if (!changed) return;
    if (next.user !== null && next.accessToken !== null) {
      yield* startSync({ user: next.user, accessToken: next.accessToken });
    }
  });

  const resumeBackgroundWork = Effect.fn("DesktopSession.resumeBackgroundWork")(function* (
    session: AuthSession,
  ) {
    yield* uploads
      .resume({ id: session.user.id, accessToken: session.accessToken })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not resume queued uploads", { cause }).pipe(
            Effect.andThen(publishIssue("Could not resume queued uploads.")),
          ),
        ),
      );
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
    if (current.user === null || current.accessToken === null) return;
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
      yield* pauseBackgroundWork;
      if (Schema.is(RpcError)(result.failure) && result.failure.code === "UNAUTHENTICATED") {
        yield* setStatus({ accessToken: null, user: current.user });
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
      yield* pauseBackgroundWork;
    }
  });

  const refresh = refreshLock.withPermit(
    Effect.gen(function* () {
      const checkedGeneration = yield* Ref.get(generation);
      const current = yield* Ref.get(status);
      const session = yield* auth.getSession().pipe(Effect.result);
      if (checkedGeneration !== (yield* Ref.get(generation))) return;
      yield* setStatus(
        Result.isSuccess(session) && session.success !== null
          ? statusFrom(session.success)
          : { accessToken: null, user: current.user },
      );
      yield* refreshCapability();
    }),
  );

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
    return yield* refreshLock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(status);
        yield* stopSync;
        yield* pauseBackgroundWork;
        const localCleanup: Effect.Effect<void, unknown> =
          current.user === null
            ? localState.update({ kind: "signed-out" })
            : accountData.purge(current.user.id);
        const localResult = yield* Effect.result(localCleanup);
        const credentialResult = yield* Effect.result(auth.signOut());
        yield* clearFileSources;
        yield* Ref.set(status, { accessToken: null, user: null });
        const localFailure = Result.isFailure(localResult) ? localResult.failure : null;
        if (localFailure !== null) {
          return yield* new DesktopSessionSignOutError({
            cause: localFailure,
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
    );
  });

  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) return;
    const cached = yield* localState.current;
    if (cached.account !== null) {
      yield* Ref.set(status, { accessToken: null, user: cached.account });
    }
    yield* refresh;
    const fiber = yield* Effect.sleep("30 seconds").pipe(
      Effect.andThen(refresh),
      Effect.forever,
      Effect.forkDetach,
    );
    yield* Ref.set(refreshFiber, fiber);
  });

  yield* Effect.addFinalizer(() =>
    Effect.all(
      [
        Ref.get(syncFiber).pipe(
          Effect.flatMap((fiber) => (fiber === null ? Effect.void : Fiber.interrupt(fiber))),
        ),
        Ref.get(refreshFiber).pipe(
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
  } satisfies DesktopSessionShape;
});

export const DesktopSessionLive = Layer.effect(DesktopSession, makeDesktopSession);
