import { Effect, Layer, PubSub, Ref, Schema, Semaphore, Stream } from "effect";

import { LocalStateSchema, type LocalState as LocalStateValue } from "../../ipc/contracts.ts";
import {
  LocalState,
  LocalStateError,
  LocalStateSnippets,
  LocalStateStore,
  type CachedLocalStateSession,
  type LocalStateShape,
  type LocalStateUpdate,
} from "../Services/LocalState.ts";

const emptyLocalState = (): LocalStateValue => ({
  revision: 0,
  account: null,
  provider: { known: false, value: null },
  capability: { status: "OFFLINE" },
  snippets: [],
});

const cachedSession = (
  account: CachedLocalStateSession["account"],
  provider: CachedLocalStateSession["provider"],
): CachedLocalStateSession => ({ account, provider });

const makeLocalState = Effect.gen(function* () {
  const store = yield* LocalStateStore;
  const snippets = yield* LocalStateSnippets;
  const persisted = yield* store.load;
  const initialItems = persisted === null ? [] : yield* snippets.read(persisted.account.id);
  const initial =
    persisted === null
      ? emptyLocalState()
      : {
          revision: 0,
          account: persisted.account,
          provider: persisted.provider,
          capability: { status: "OFFLINE" } as const,
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
  ) {
    const materializedSnippets =
      nextSession === null ? [] : yield* snippets.read(nextSession.account.id);
    yield* publish({
      account: nextSession?.account ?? null,
      provider: nextSession?.provider ?? { known: false, value: null },
      capability,
      snippets: materializedSnippets,
    });
  });

  const update = Effect.fn("LocalState.update")((input: LocalStateUpdate) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (input.kind === "signed-out") {
          yield* store.save(null);
          yield* Ref.set(session, null);
          yield* materializeSession(null, { status: "OFFLINE" });
          return;
        }

        const currentSession = yield* Ref.get(session);
        // Provider knowledge belongs to the account that established it. An offline refresh for the
        // same account may reuse that cached display fact, while an account switch must forget it.
        const nextSession =
          input.kind === "online"
            ? cachedSession(input.account, {
                known: true,
                value: input.accountStatus.storageProvider,
              })
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
        yield* store.save(nextSession);
        yield* Ref.set(session, nextSession);
        yield* materializeSession(nextSession, capability);
      }),
    ),
  );

  const refresh = lock.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const currentSession = yield* Ref.get(session);
      yield* materializeSession(currentSession, current.capability);
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
    refresh,
    update,
  } satisfies LocalStateShape;
});

export const LocalStateLive = Layer.effect(LocalState, makeLocalState);
