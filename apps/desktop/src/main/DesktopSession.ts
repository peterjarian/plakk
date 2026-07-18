import type { User } from "@plakk/shared";
import { accountCanSyncWithConnection } from "@plakk/shared/PlakkApi";
import { SnippetHydrationEngine } from "@plakk/shared/SnippetHydration";
import {
  ManagedSnippetContent,
  runSnippetReplicaSync,
  SnippetRemoteTransport,
  SnippetReplica,
} from "@plakk/shared/SnippetReplica";
import {
  Context,
  Effect,
  Fiber,
  Layer,
  PubSub,
  Ref,
  Result,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { rm } from "node:fs/promises";

import { getAccountStatusWithConnection, isUnauthenticatedAccountError } from "./accountStatus.ts";
import { AuthService, type AuthServiceFailure, type AuthSession } from "./auth/AuthService.ts";
import { DesktopAccountData } from "./DesktopAccountData.ts";
import { DesktopProjection } from "./DesktopProjection.ts";
import { NativeFileSources } from "./NativeFileSources.ts";
import { PlakkRpcClient } from "./PlakkRpcClient.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";
import { UserConfigStore } from "./UserConfigStore.ts";

type SessionStatus = { readonly accessToken: string | null; readonly user: User | null };
export type DesktopSessionAccount = { readonly id: string; readonly accessToken: string | null };

export class DesktopSessionSignOutError extends Schema.TaggedErrorClass<DesktopSessionSignOutError>()(
  "DesktopSessionSignOutError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

const statusFrom = (session: AuthSession | null): SessionStatus => ({
  accessToken: session?.accessToken ?? null,
  user: session?.user ?? null,
});

export class DesktopSession extends Context.Service<
  DesktopSession,
  {
    readonly issues: Stream.Stream<string>;
    readonly currentAccount: Effect.Effect<DesktopSessionAccount | null>;
    handleCallbackUrl(rawUrl: string): Effect.Effect<AuthSession | null, AuthServiceFailure>;
    readonly refresh: Effect.Effect<void>;
    readonly start: Effect.Effect<void>;
    readonly signOut: Effect.Effect<void, DesktopSessionSignOutError>;
  }
>()("plakk/main/DesktopSession") {
  static readonly Live = Layer.effect(
    DesktopSession,
    Effect.gen(function* () {
      const auth = yield* AuthService;
      const accountData = yield* DesktopAccountData;
      const projection = yield* DesktopProjection;
      const files = yield* NativeFileSources;
      const uploads = yield* SnippetUploadEngine;
      const hydration = yield* SnippetHydrationEngine;
      const config = yield* UserConfigStore;
      const replica = yield* SnippetReplica;
      const remote = yield* SnippetRemoteTransport;
      const managedContent = yield* ManagedSnippetContent;
      const rpc = yield* PlakkRpcClient;
      const status = yield* Ref.make<SessionStatus>({ accessToken: null, user: null });
      const generation = yield* Ref.make(0);
      const started = yield* Ref.make(false);
      const syncFiber = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
      const refreshFiber = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);
      const refreshLock = yield* Semaphore.make(1);
      const issues = yield* PubSub.unbounded<string>();

      const publishIssue = (message: string) => PubSub.publish(issues, message);
      const clearFileSources = Effect.suspend(() =>
        Effect.forEach(
          files.discardAll(),
          (temporaryPath) =>
            Effect.tryPromise(() => rm(temporaryPath, { force: true })).pipe(
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
        if (accountChanged) yield* clearFileSources;
        yield* Ref.set(status, next);
        if (next.user !== null) {
          yield* projection
            .update({ kind: "offline", account: next.user })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Could not update the cached desktop account", { cause }),
              ),
            );
        }
        if (!changed) return;
        yield* Ref.update(generation, (value) => value + 1);
        yield* stopSync;
        yield* pauseBackgroundWork;
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
        const settingsResult = yield* config.get.pipe(Effect.result);
        if (Result.isFailure(settingsResult)) {
          yield* Effect.logError("Could not load offline snippet settings", {
            cause: settingsResult.failure,
          });
          yield* publishIssue("Could not resume background snippet work.");
          return;
        }
        const settings = settingsResult.success;
        yield* hydration
          .resume(
            { id: session.user.id, accessToken: session.accessToken },
            { keepAllFilesOffline: settings.keepAllFilesOffline },
          )
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
        const result = yield* getAccountStatusWithConnection(current.accessToken).pipe(
          Effect.provideService(PlakkRpcClient, rpc),
          Effect.scoped,
          Effect.result,
        );
        const latest = yield* Ref.get(status);
        if (
          checkedGeneration !== (yield* Ref.get(generation)) ||
          latest.accessToken !== current.accessToken
        ) {
          return;
        }
        if (Result.isFailure(result)) {
          yield* pauseBackgroundWork;
          if (isUnauthenticatedAccountError(result.failure)) {
            yield* setStatus({ accessToken: null, user: current.user });
          } else {
            yield* projection
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
        yield* projection
          .update({
            kind: "online",
            account: current.user,
            accountStatus: account,
            connection,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Could not confirm the desktop projection capability", { cause }),
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
            const localResult =
              current.user === null
                ? yield* Effect.result(projection.update({ kind: "signed-out" }))
                : yield* Effect.result(accountData.purge(current.user.id));
            const credentialResult = yield* Effect.result(auth.signOut());
            yield* clearFileSources;
            yield* Ref.set(status, { accessToken: null, user: null });
            const localFailure =
              localResult._tag === "Failure" ? (localResult.failure as unknown) : null;
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
        const cached = yield* projection.current;
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

      return DesktopSession.of({
        currentAccount: Ref.get(status).pipe(
          Effect.map((current) =>
            current.user === null
              ? null
              : { id: current.user.id, accessToken: current.accessToken },
          ),
        ),
        issues: Stream.fromPubSub(issues),
        handleCallbackUrl,
        refresh,
        signOut,
        start,
      });
    }),
  );
}
