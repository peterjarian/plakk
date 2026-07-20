import { Effect, Layer, PubSub, Ref, Schema, Semaphore, Stream } from "effect";

import { LocalStateSchema, type LocalState as LocalStateValue } from "../../ipc/contracts.ts";
import {
  LocalState,
  LocalStateError,
  type CachedLocalStateSession,
  type LocalStateShape,
  type LocalStateUpdate,
} from "./LocalState.ts";
import { LocalStateSnippets } from "./LocalStateSnippets.ts";
import { LocalStateStore } from "./LocalStateStore.ts";

const emptyLocalState = (): LocalStateValue => ({
  revision: 0,
  account: null,
  provider: { known: false, value: null },
  capability: { status: "OFFLINE" },
  liveConnection: null,
  snippets: [],
});

const cachedSession = (
  account: CachedLocalStateSession["account"],
  provider: CachedLocalStateSession["provider"],
): CachedLocalStateSession => ({ account, provider, cleanupPending: false });

const confirmedProvider = (
  current: CachedLocalStateSession["provider"],
  accountStatus: Extract<LocalStateUpdate, { readonly kind: "online" }>["accountStatus"],
  connection: Extract<LocalStateUpdate, { readonly kind: "online" }>["connection"],
): CachedLocalStateSession["provider"] => {
  if (accountStatus.storageProvider === null) return { known: true, value: null };
  if (connection?.storageProvider !== accountStatus.storageProvider) return current;
  return connection.status === "NOT_CONNECTED"
    ? { known: true, value: null }
    : { known: true, value: accountStatus.storageProvider };
};

const makeLocalState = Effect.gen(function* () {
  const store = yield* LocalStateStore;
  const snippets = yield* LocalStateSnippets;
  const persisted = yield* store.load;
  const initialItems =
    persisted === null || persisted.cleanupPending
      ? []
      : yield* snippets.read(persisted.account.id);
  const initial =
    persisted === null || persisted.cleanupPending
      ? emptyLocalState()
      : {
          revision: 0,
          account: persisted.account,
          provider: persisted.provider,
          capability: { status: "OFFLINE" } as const,
          liveConnection: { status: "RECONNECTING" } as const,
          snippets: initialItems,
        };
  yield* Schema.decodeUnknownEffect(LocalStateSchema)(initial).pipe(
    Effect.mapError(
      (cause) =>
        new LocalStateError({
          cause,
          reason: "The initial local state is invalid.",
        }),
    ),
  );

  const state = yield* Ref.make<LocalStateValue>(initial);
  const session = yield* Ref.make<CachedLocalStateSession | null>(persisted);
  const changes = yield* PubSub.unbounded<LocalStateValue>();
  const lock = yield* Semaphore.make(1);

  const publish = Effect.fn("LocalState.publish")(function* (
    next: Omit<LocalStateValue, "revision">,
  ) {
    const current = yield* Ref.get(state);
    const materialized: LocalStateValue = { ...next, revision: current.revision + 1 };
    yield* Schema.decodeUnknownEffect(LocalStateSchema)(materialized).pipe(
      Effect.mapError(
        (cause) =>
          new LocalStateError({
            cause,
            reason: "Local state is invalid.",
          }),
      ),
    );
    yield* Ref.set(state, materialized);
    yield* PubSub.publish(changes, materialized);
  });

  const materializeSession = Effect.fn("LocalState.materializeSession")(function* (
    nextSession: CachedLocalStateSession | null,
    capability: LocalStateValue["capability"],
    liveConnection: LocalStateValue["liveConnection"],
  ) {
    const materializedSnippets =
      nextSession === null ? [] : yield* snippets.read(nextSession.account.id);
    return {
      account: nextSession?.account ?? null,
      provider: nextSession?.provider ?? { known: false, value: null },
      capability,
      liveConnection: nextSession === null ? null : liveConnection,
      snippets: materializedSnippets,
    } satisfies Omit<LocalStateValue, "revision">;
  });

  const update = Effect.fn("LocalState.update")((input: LocalStateUpdate) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (input.kind === "owner-cleanup-pending") {
          const currentSession = yield* Ref.get(session);
          const lockedSession =
            currentSession === null ? null : { ...currentSession, cleanupPending: true };
          const next = yield* materializeSession(null, { status: "OFFLINE" }, null);
          yield* store.save(lockedSession);
          yield* Ref.set(session, lockedSession);
          yield* publish(next);
          return;
        }
        if (input.kind === "signed-out") {
          const next = yield* materializeSession(null, { status: "OFFLINE" }, null);
          yield* store.save(null);
          yield* Ref.set(session, null);
          yield* publish(next);
          return;
        }

        const currentSession = yield* Ref.get(session);
        const currentState = yield* Ref.get(state);
        if (input.kind === "live-connection") {
          if (currentSession?.account.id !== input.accountId || currentSession.cleanupPending)
            return;
          const next = yield* materializeSession(currentSession, currentState.capability, {
            status: input.status,
          });
          yield* publish(next);
          return;
        }
        if (
          currentSession?.cleanupPending === true &&
          currentSession.account.id === input.account.id
        ) {
          return;
        }
        // Provider knowledge belongs to the account that established it. An offline refresh for the
        // same account may reuse that cached display fact, while an account switch must forget it.
        const nextSession =
          input.kind === "online"
            ? cachedSession(
                input.account,
                confirmedProvider(
                  currentSession?.account.id === input.account.id
                    ? currentSession.provider
                    : { known: false, value: null },
                  input.accountStatus,
                  input.connection,
                ),
              )
            : currentSession?.account.id === input.account.id
              ? cachedSession(input.account, currentSession.provider)
              : cachedSession(input.account, { known: false, value: null });
        const capability =
          // Capability is deliberately live-only: persisted and restored state remains offline until
          // the backend authoritatively confirms that the current account can sync.
          input.kind === "online"
            ? ({
                status: "ONLINE",
                account: input.accountStatus,
                connection: input.connection,
              } as const)
            : ({ status: "OFFLINE" } as const);
        const sameAccount = currentSession?.account.id === nextSession.account.id;
        const next = yield* materializeSession(
          nextSession,
          capability,
          sameAccount && currentState.liveConnection !== null
            ? currentState.liveConnection
            : { status: "RECONNECTING" },
        );
        yield* store.save(nextSession);
        yield* Ref.set(session, nextSession);
        yield* publish(next);
      }),
    ),
  );

  const refresh = lock.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const currentSession = yield* Ref.get(session);
      const next = yield* materializeSession(
        currentSession?.cleanupPending === true ? null : currentSession,
        currentSession?.cleanupPending === true ? { status: "OFFLINE" } : current.capability,
        currentSession?.cleanupPending === true ? null : current.liveConnection,
      );
      yield* publish(next);
    }),
  );

  yield* snippets.changes.pipe(
    Stream.runForEach((accountId) =>
      Ref.get(session).pipe(
        Effect.flatMap((active) => (active?.account.id === accountId ? refresh : Effect.void)),
        Effect.catchCause((cause) => Effect.logError("Could not refresh local state", { cause })),
      ),
    ),
    Effect.forkScoped,
  );

  return {
    changes: Stream.fromPubSub(changes),
    current: Ref.get(state),
    owner: Ref.get(session).pipe(
      Effect.map((current) =>
        current === null
          ? null
          : { account: current.account, cleanupPending: current.cleanupPending },
      ),
    ),
    refresh,
    update,
  } satisfies LocalStateShape;
});

export const LocalStateLive = Layer.effect(LocalState, makeLocalState);
