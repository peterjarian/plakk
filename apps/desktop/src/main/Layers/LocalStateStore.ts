import ElectronStore from "electron-store";
import { Effect, Layer, Schema } from "effect";
import { UserSchema } from "@plakk/shared";

import {
  CachedLocalStateSessionSchema,
  LocalStateError,
  LocalStateStore,
  type CachedLocalStateSession,
  type LocalStateStoreShape,
} from "../Services/LocalState.ts";

const StoredLocalStateSessionCodec = Schema.fromJsonString(CachedLocalStateSessionSchema);
const StoredLegacyAccountCodec = Schema.fromJsonString(UserSchema);
const legacyStoreName = "desktop-projection";
const legacyAccountStoreName = "snippet-replica-account";

type SessionStore = ElectronStore<{ session: string | null }>;
type LegacyAccountStore = ElectronStore<{ active: string | null }>;

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

const openLegacyAccountStore = (options: { readonly cwd?: string }) =>
  Effect.try({
    try: () =>
      new ElectronStore<{ active: string | null }>({
        clearInvalidConfig: true,
        defaults: { active: null },
        name: legacyAccountStoreName,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      }),
    catch: (cause) =>
      new LocalStateError({
        cause,
        reason: "Could not open the legacy active-account store.",
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

const readLegacyAccount = (store: LegacyAccountStore) =>
  Effect.try({
    try: () => store.get("active"),
    catch: (cause) =>
      new LocalStateError({
        cause,
        reason: "Could not read the legacy active-account store.",
      }),
  });

const clearLegacyAccount = (store: LegacyAccountStore) =>
  Effect.try({
    try: () => store.set("active", null),
    catch: (cause) =>
      new LocalStateError({
        cause,
        reason: "Could not clear the legacy active-account store.",
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
    const legacyAccountStore = yield* openLegacyAccountStore(options);

    const load = Effect.fn("LocalStateStore.load")(function* () {
      const current = yield* readSession(store);
      if (current !== null) {
        const session = yield* decodeStoredSession(store, current);
        yield* writeSession(legacyStore, null);
        yield* clearLegacyAccount(legacyAccountStore);
        return session;
      }

      const legacy = yield* readSession(legacyStore);
      if (legacy !== null) {
        const session = yield* decodeStoredSession(legacyStore, legacy);
        if (session !== null) {
          yield* writeSession(store, legacy);
          yield* writeSession(legacyStore, null);
          yield* clearLegacyAccount(legacyAccountStore);
          return session;
        }
      }

      const legacyAccount = yield* readLegacyAccount(legacyAccountStore);
      if (legacyAccount === null) return null;
      const account = yield* Schema.decodeEffect(StoredLegacyAccountCodec)(legacyAccount).pipe(
        Effect.mapError(
          (cause) =>
            new LocalStateError({
              cause,
              reason: "Stored legacy account is invalid.",
            }),
        ),
        Effect.catch((error) =>
          clearLegacyAccount(legacyAccountStore).pipe(
            Effect.tap(() => Effect.logWarning("Discarded invalid legacy account", { error })),
            Effect.as(null),
          ),
        ),
      );
      if (account === null) return null;
      const migrated = { account, provider: { known: false, value: null } } as const;
      const json = yield* Schema.encodeEffect(StoredLocalStateSessionCodec)(migrated).pipe(
        Effect.mapError(
          (cause) =>
            new LocalStateError({
              cause,
              reason: "Legacy account could not be migrated to local state.",
            }),
        ),
      );
      yield* writeSession(store, json);
      yield* writeSession(legacyStore, null);
      yield* clearLegacyAccount(legacyAccountStore);
      return migrated;
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
      yield* writeSession(legacyStore, null);
      yield* clearLegacyAccount(legacyAccountStore);
    });

    return { load: load(), save } satisfies LocalStateStoreShape;
  });

export const makeLocalStateStoreLive = (options: { readonly cwd?: string } = {}) =>
  Layer.effect(LocalStateStore, makeLocalStateStore(options));

export const LocalStateStoreLive = makeLocalStateStoreLive();
