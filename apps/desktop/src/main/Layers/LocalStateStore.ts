import ElectronStore from "electron-store";
import { Effect, Layer, Schema } from "effect";

import {
  CachedLocalStateSessionSchema,
  LocalStateError,
  LocalStateStore,
  type CachedLocalStateSession,
  type LocalStateStoreShape,
} from "../Services/LocalState.ts";

const StoredLocalStateSessionCodec = Schema.fromJsonString(CachedLocalStateSessionSchema);
const legacyStoreName = "desktop-projection";

type SessionStore = ElectronStore<{ session: string | null }>;

const openStore = (name: string, options: { readonly cwd?: string }) =>
  Effect.try({
    try: () =>
      new ElectronStore<{ session: string | null }>({
        clearInvalidConfig: true,
        defaults: { session: null },
        name,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      }),
    catch: (cause) =>
      new LocalStateError({
        cause,
        reason: "Could not open the local state store.",
      }),
  });

const readSession = (store: SessionStore) =>
  Effect.try({
    try: () => store.get("session"),
    catch: (cause) =>
      new LocalStateError({
        cause,
        reason: "Could not read the local state store.",
      }),
  });

const writeSession = (store: SessionStore, session: string | null) =>
  Effect.try({
    try: () => store.set("session", session),
    catch: (cause) =>
      new LocalStateError({
        cause,
        reason: "Could not save local state.",
      }),
  });

const decodeStoredSession = (store: SessionStore, json: string) =>
  Schema.decodeEffect(StoredLocalStateSessionCodec)(json).pipe(
    Effect.mapError(
      (cause) =>
        new LocalStateError({
          cause,
          reason: "Stored local state is invalid.",
        }),
    ),
    Effect.catch((error) =>
      writeSession(store, null).pipe(
        Effect.tap(() => Effect.logWarning("Discarded invalid cached local state", { error })),
        Effect.as(null),
      ),
    ),
  );

const makeLocalStateStore = (options: { readonly cwd?: string } = {}) =>
  Effect.gen(function* () {
    const store = yield* openStore("local-state", options);
    const legacyStore = yield* openStore(legacyStoreName, options);

    const load = Effect.fn("LocalStateStore.load")(function* () {
      const current = yield* readSession(store);
      if (current !== null) return yield* decodeStoredSession(store, current);

      const legacy = yield* readSession(legacyStore);
      if (legacy === null) return null;
      const session = yield* decodeStoredSession(legacyStore, legacy);
      if (session === null) return null;
      yield* writeSession(store, legacy);
      yield* writeSession(legacyStore, null);
      return session;
    });

    const save = Effect.fn("LocalStateStore.save")(function* (
      session: CachedLocalStateSession | null,
    ) {
      const json =
        session === null
          ? null
          : yield* Schema.encodeEffect(StoredLocalStateSessionCodec)(session).pipe(
              Effect.mapError(
                (cause) =>
                  new LocalStateError({
                    cause,
                    reason: "Local state is invalid.",
                  }),
              ),
            );
      yield* writeSession(store, json);
    });

    return { load: load(), save } satisfies LocalStateStoreShape;
  });

export const makeLocalStateStoreLive = (options: { readonly cwd?: string } = {}) =>
  Layer.effect(LocalStateStore, makeLocalStateStore(options));

export const LocalStateStoreLive = makeLocalStateStoreLive();
