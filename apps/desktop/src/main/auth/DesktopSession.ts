import {
  Client,
  type ClientError,
  type ClientSnapshot,
  clientLayer,
  ContentStore,
  CurrentSession,
  OfflineError,
  SessionError,
} from "@plakk/client-runtime";
import type { User } from "@plakk/shared";
import {
  Context,
  Cause,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  Result,
  ScopedRef,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import * as EffectRpcClient from "effect/unstable/rpc/RpcClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { LocalState } from "../../ipc/contracts.ts";
import { AuthService, type AuthServiceFailure, type AuthSession } from "./AuthService.ts";
import { DesktopContentStore } from "../snippets/DesktopContentStore.ts";
import { NativeFileSources } from "../snippets/NativeFileSources.ts";

export type DesktopSessionTransitionError = AuthServiceFailure | ClientError | SessionError;

export interface DesktopSessionShape {
  /** Returns the latest renderer transport snapshot. */
  readonly current: Effect.Effect<LocalState>;
  /** Emits the current renderer transport snapshot and every later revision. */
  readonly changes: Stream.Stream<LocalState>;
  readonly handleCallbackUrl: (
    rawUrl: string,
  ) => Effect.Effect<AuthSession | null, DesktopSessionTransitionError>;
  readonly refresh: Effect.Effect<void, DesktopSessionTransitionError>;
  readonly start: Effect.Effect<void, DesktopSessionTransitionError>;
  readonly signOut: Effect.Effect<void, DesktopSessionTransitionError>;
  readonly withClient: <A, E>(
    command: (client: Client["Service"]) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | SessionError>;
}

export class DesktopSession extends Context.Service<DesktopSession, DesktopSessionShape>()(
  "plakk/main/auth/DesktopSession",
) {}

type SessionStatus = {
  readonly accessToken: string | null;
  readonly user: User | null;
  readonly commandsAuthorized: boolean;
};

type ActiveClient = {
  readonly userId: string;
  readonly client: Client["Service"];
};

type SharedClientLayer = Layer.Layer<
  Client,
  ClientError,
  | ContentStore
  | CurrentSession
  | HttpClient.HttpClient
  | EffectRpcClient.Protocol
  | SqlClient.SqlClient
>;

const emptyState = (revision = 0): LocalState => ({
  revision,
  user: null,
  capability: {
    status: "OFFLINE",
    storageProvider: { known: false, value: null },
  },
  syncStatus: null,
  storageUsageBytes: 0,
  snippets: [],
});

const offlineState = (user: User, revision: number): LocalState => ({
  ...emptyState(revision),
  user,
});

const statusFrom = (session: AuthSession | null): SessionStatus => ({
  accessToken: session?.accessToken ?? null,
  user: session?.user ?? null,
  commandsAuthorized: session !== null,
});

const makeDesktopSession = (sharedClientLayer: SharedClientLayer) =>
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const files = yield* NativeFileSources;
    const desktopContent = yield* DesktopContentStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const http = yield* HttpClient.HttpClient;
    const protocol = yield* EffectRpcClient.Protocol;
    const status = yield* Ref.make<SessionStatus>({
      accessToken: null,
      user: null,
      commandsAuthorized: false,
    });
    const activeClient = yield* ScopedRef.make<Option.Option<ActiveClient>>(() => Option.none());
    const state = yield* SubscriptionRef.make<LocalState>(emptyState());
    const started = yield* Ref.make(false);
    const refreshLock = yield* Semaphore.make(1);
    const commandLock = yield* Semaphore.make(1);
    const publish = Effect.fn("DesktopSession.publish")(function* (
      next: Omit<LocalState, "revision">,
    ) {
      yield* SubscriptionRef.update(state, (current) => ({
        ...next,
        revision: current.revision + 1,
      }));
    });

    const publishOffline = Effect.fn("DesktopSession.publishOffline")(function* (user: User) {
      const current = yield* SubscriptionRef.get(state);
      yield* publish(offlineState(user, current.revision));
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

    const accessTokenFor = (userId: string): Effect.Effect<string, OfflineError | SessionError> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(status);
        if (current.user?.id !== userId || !current.commandsAuthorized) {
          return yield* new SessionError({
            message: "Your Plakk session is no longer available. Sign in again to continue.",
          });
        }

        const refreshed = yield* auth.getSession().pipe(Effect.result);
        if (Result.isFailure(refreshed)) {
          const expired = refreshed.failure._tag === "AuthSessionExpiredError";
          yield* Ref.set(status, {
            accessToken: null,
            user: current.user,
            commandsAuthorized: !expired,
          });
          if (expired) {
            return yield* new SessionError({
              message: "Your Plakk session is no longer available. Sign in again to continue.",
            });
          }
          return yield* new OfflineError({
            message: "Plakk is offline. Your local snippets remain available.",
          });
        }

        const session = refreshed.success;
        const latest = yield* Ref.get(status);
        if (
          session === null ||
          session.user.id !== userId ||
          latest.user?.id !== userId ||
          !latest.commandsAuthorized
        ) {
          return yield* new SessionError({
            message: "Your Plakk session is no longer available. Sign in again to continue.",
          });
        }
        yield* Ref.set(status, statusFrom(session));
        return session.accessToken;
      });

    const publishClientSnapshot = Effect.fn("DesktopSession.publishClientSnapshot")(function* (
      snapshot: ClientSnapshot,
      preview: ReturnType<DesktopContentStore["Service"]["forUser"]>["preview"],
    ) {
      const projected = yield* Effect.forEach(snapshot.snippets, (snippet) =>
        snippet.title === undefined
          ? preview(snippet).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not read a desktop snippet preview", {
                  snippetId: snippet.id,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(null)),
              ),
              Effect.map((localTextPreview) => ({ snippet, localTextPreview })),
            )
          : Effect.succeed({ snippet, localTextPreview: null }),
      );
      yield* publish({
        user: snapshot.user,
        capability: snapshot.capability,
        syncStatus: snapshot.syncStatus,
        storageUsageBytes: snapshot.storageUsageBytes,
        snippets: projected,
      });
    });

    const observeClient = Effect.fn("DesktopSession.observeClient")(function* (
      client: Client["Service"],
      preview: ReturnType<DesktopContentStore["Service"]["forUser"]>["preview"],
    ) {
      yield* client.subscribe().pipe(
        Stream.runForEach((snapshot) => publishClientSnapshot(snapshot, preview)),
        Effect.catchCause((cause) =>
          Effect.logError("Desktop client observation stopped", { cause }),
        ),
        Effect.forkScoped,
      );
    });

    const activateClient = Effect.fn("DesktopSession.activateClient")(function* (user: User) {
      const content = desktopContent.forUser(user.id);
      const dependencies = Layer.mergeAll(
        Layer.succeed(
          CurrentSession,
          CurrentSession.of({ user, accessToken: accessTokenFor(user.id) }),
        ),
        Layer.succeed(ContentStore, content.store),
        Layer.succeed(SqlClient.SqlClient, sql),
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(EffectRpcClient.Protocol, protocol),
      );
      yield* ScopedRef.set(
        activeClient,
        Effect.gen(function* () {
          const context = yield* Layer.build(sharedClientLayer.pipe(Layer.provide(dependencies)));
          const client = Context.get(context, Client);
          yield* observeClient(client, content.preview);
          return Option.some({ userId: user.id, client });
        }),
      );
    });

    const deactivateClient = ScopedRef.set(activeClient, Effect.succeed(Option.none()));

    const purgeActiveClient = Effect.fn("DesktopSession.purgeActiveClient")(function* (
      userId: string,
    ) {
      const active = yield* ScopedRef.get(activeClient);
      if (Option.isNone(active) || active.value.userId !== userId) {
        yield* deactivateClient;
        return false;
      }
      const client = active.value.client;
      yield* deactivateClient;
      yield* client.clearLocalData;
      return true;
    });

    const clearOwner = Effect.fn("DesktopSession.clearOwner")(function* (user: User) {
      yield* auth.setCleanupOwner(user);
      yield* clearFileSources;
      if (!(yield* purgeActiveClient(user.id))) {
        return yield* new SessionError({
          message: "Plakk could not access the local account data.",
        });
      }
      yield* auth.setCleanupOwner(null);
    });

    const setStatus = Effect.fn("DesktopSession.setStatus")(function* (next: SessionStatus) {
      const previous = yield* Ref.get(status);
      if (previous.user?.id === next.user?.id) {
        yield* Ref.set(status, next);
        return;
      }

      yield* Ref.set(status, {
        accessToken: null,
        user: previous.user,
        commandsAuthorized: false,
      });
      yield* commandLock.withPermit(
        Effect.gen(function* () {
          if (previous.user !== null) {
            yield* clearOwner(previous.user);
          } else {
            yield* deactivateClient;
          }

          yield* Ref.set(status, next);
          if (next.user === null) {
            yield* publish(emptyState());
            return;
          }
          yield* publishOffline(next.user);
          yield* activateClient(next.user);
        }),
      );
    });

    const reconcileStoredAccount = Effect.fn("DesktopSession.reconcileStoredAccount")(function* () {
      const cleanupOwner = yield* auth.cleanupOwner;
      if (cleanupOwner !== null) {
        yield* Ref.set(status, {
          accessToken: null,
          user: cleanupOwner,
          commandsAuthorized: false,
        });
        yield* publishOffline(cleanupOwner);
        yield* activateClient(cleanupOwner);
        yield* clearOwner(cleanupOwner);
        yield* Ref.set(status, {
          accessToken: null,
          user: null,
          commandsAuthorized: false,
        });
        yield* publish(emptyState());
      }

      const storedAccount = yield* auth.getStoredAccount();
      yield* setStatus({
        accessToken: null,
        user: storedAccount,
        commandsAuthorized: storedAccount !== null,
      });
    });

    const clearSession = Effect.fn("DesktopSession.clearSession")(function* () {
      yield* commandLock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(status);
          yield* Ref.set(status, {
            accessToken: null,
            user: current.user,
            commandsAuthorized: false,
          });
          if (current.user !== null) {
            yield* auth.setCleanupOwner(current.user);
            yield* clearFileSources;
            const localDataCleared = yield* purgeActiveClient(current.user.id).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not remove local account data during sign-out", {
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(false)),
              ),
            );
            yield* auth.signOut();
            if (localDataCleared) yield* auth.setCleanupOwner(null);
          } else {
            yield* deactivateClient;
            yield* auth.signOut();
          }
          yield* Ref.set(status, {
            accessToken: null,
            user: null,
            commandsAuthorized: false,
          });
          yield* publish(emptyState());
        }),
      );
    });

    const reconcileCredentials = Effect.fn("DesktopSession.reconcileCredentials")(function* () {
      const current = yield* Ref.get(status);
      const session = yield* auth.getSession().pipe(Effect.result);
      if (Result.isSuccess(session)) {
        yield* setStatus(statusFrom(session.success));
        return;
      }
      if (session.failure._tag === "AuthSessionExpiredError") {
        yield* clearSession();
        return;
      }
      yield* Ref.set(status, {
        accessToken: null,
        user: current.user,
        commandsAuthorized: current.user !== null,
      });
    });

    const refresh = refreshLock.withPermit(
      Effect.gen(function* () {
        yield* reconcileCredentials();
        const active = yield* ScopedRef.get(activeClient);
        if (Option.isSome(active)) {
          yield* active.value.client.refresh;
        }
      }),
    );

    const handleCallbackUrl = (rawUrl: string) =>
      refreshLock.withPermit(
        Effect.gen(function* () {
          const session = yield* auth.handleCallbackUrl(rawUrl);
          if (session !== null) {
            yield* setStatus(statusFrom(session));
            const active = yield* ScopedRef.get(activeClient);
            if (Option.isSome(active)) yield* active.value.client.refresh;
          }
          return session;
        }),
      );

    const signOut = refreshLock.withPermit(clearSession());

    const start = Effect.gen(function* () {
      if (yield* Ref.getAndSet(started, true)) return;
      yield* reconcileStoredAccount();
      yield* refresh.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not refresh the initial desktop session", { cause }),
        ),
        Effect.forkDetach,
      );
    });

    const withClient: DesktopSessionShape["withClient"] = Effect.fn("DesktopSession.withClient")(
      function* <A, E>(command: (client: Client["Service"]) => Effect.Effect<A, E>) {
        return yield* commandLock.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(status);
            const active = yield* ScopedRef.get(activeClient);
            if (
              current.user === null ||
              !current.commandsAuthorized ||
              Option.isNone(active) ||
              active.value.userId !== current.user.id
            ) {
              return yield* new SessionError({
                message: "The desktop account is not ready for commands.",
              });
            }
            return yield* command(active.value.client);
          }),
        );
      },
    );

    return {
      current: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      handleCallbackUrl,
      refresh,
      signOut,
      start,
      withClient,
    } satisfies DesktopSessionShape;
  });

export const makeDesktopSessionLive = (sharedClientLayer: SharedClientLayer) =>
  Layer.effect(DesktopSession, makeDesktopSession(sharedClientLayer));

export const DesktopSessionLive = makeDesktopSessionLive(clientLayer);
