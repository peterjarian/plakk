import { NodeFileSystem } from "@effect/platform-node";
import { UserSchema, type User } from "@plakk/shared";
import type { AccountStatus, PipeConnection } from "@plakk/shared/PlakkApi";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, ManagedRuntime, Schema, Stream } from "effect";
import ElectronStore from "electron-store";

import type { DesktopSnippet } from "../ipc/contracts.ts";
import { LocalStateLive } from "./Layers/LocalState.ts";
import { makeLocalStateStoreLive } from "./Layers/LocalStateStore.ts";
import {
  CachedLocalStateSessionSchema,
  LocalState,
  LocalStateError,
  LocalStateSnippets,
} from "./Services/LocalState.ts";

const user = (id: string): User => ({
  id,
  email: `${id}@example.com`,
  firstName: id,
  lastName: "User",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const snippet = (id: string, fileName: string): DesktopSnippet => ({
  id,
  fileName,
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE",
  uploadStatus: "UPLOADED",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  localState: null,
  localTextPreview: "test",
  localContentAvailability: { status: "AVAILABLE" },
});

const onlineAccount: AccountStatus = {
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
  blockedReasons: [],
};

const connected: PipeConnection = {
  storageProvider: "GOOGLE_DRIVE",
  status: "CONNECTED",
  externalDestinationUrl: "https://drive.example.com/folder",
};

const notConnected: PipeConnection = {
  storageProvider: "GOOGLE_DRIVE",
  status: "NOT_CONNECTED",
  externalDestinationUrl: null,
};

const makeRuntime = (
  cwd: string,
  items: Readonly<Record<string, ReadonlyArray<DesktopSnippet>>>,
) => {
  const localStateSnippets = Layer.succeed(
    LocalStateSnippets,
    LocalStateSnippets.of({
      changes: Stream.empty,
      read: (accountId) => Effect.succeed(items[accountId] ?? []),
    }),
  );
  const store = makeLocalStateStoreLive({ cwd });
  return ManagedRuntime.make(
    LocalStateLive.pipe(Layer.provide(Layer.merge(store, localStateSnippets))),
  );
};

it.layer(NodeFileSystem.layer)("local state", (it) => {
  it.effect("restores cached account, provider, and snippets offline after a restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-" });
      const firstSnippet = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "first.txt");
      const account = user("user_1");

      const firstRuntime = makeRuntime(cwd, { [account.id]: [firstSnippet] });
      yield* Effect.promise(() =>
        firstRuntime.runPromise(
          LocalState.use((localState) =>
            localState.update({
              kind: "online",
              account,
              accountStatus: onlineAccount,
              connection: connected,
            }),
          ),
        ),
      );
      yield* Effect.promise(() => firstRuntime.dispose());

      const restartedRuntime = makeRuntime(cwd, { [account.id]: [firstSnippet] });
      const restored = yield* Effect.promise(() =>
        restartedRuntime.runPromise(LocalState.use((localState) => localState.current)),
      );
      yield* Effect.promise(() => restartedRuntime.dispose());

      expect(restored).toMatchObject({
        account,
        provider: { known: true, value: "GOOGLE_DRIVE" },
        capability: { status: "OFFLINE" },
        snippets: [firstSnippet],
      });
    }),
  );

  it.effect("switches account-scoped state without leaking the previous account", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-" });
      const firstAccount = user("user_1");
      const secondAccount = user("user_2");
      const firstSnippet = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "first.txt");
      const secondSnippet = snippet("1d1e2f3a-4567-4890-8abc-def012345679", "second.txt");
      const runtime = makeRuntime(cwd, {
        [firstAccount.id]: [firstSnippet],
        [secondAccount.id]: [secondSnippet],
      });

      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) =>
            localState.update({
              kind: "online",
              account: firstAccount,
              accountStatus: onlineAccount,
              connection: connected,
            }),
          ),
        ),
      );
      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) =>
            localState.update({ kind: "offline", account: secondAccount }),
          ),
        ),
      );
      const switched = yield* Effect.promise(() =>
        runtime.runPromise(LocalState.use((localState) => localState.current)),
      );
      yield* Effect.promise(() => runtime.dispose());

      expect(switched.account).toEqual(secondAccount);
      expect(switched.provider).toEqual({ known: false, value: null });
      expect(switched.snippets).toEqual([secondSnippet]);
    }),
  );

  it.effect("does not cache a configured provider until its link is confirmed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-" });
      const account = user("user_1");
      const runtime = makeRuntime(cwd, { [account.id]: [] });

      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) =>
            localState.update({
              kind: "online",
              account,
              accountStatus: onlineAccount,
              connection: notConnected,
            }),
          ),
        ),
      );
      const current = yield* Effect.promise(() =>
        runtime.runPromise(LocalState.use((localState) => localState.current)),
      );
      yield* Effect.promise(() => runtime.dispose());

      expect(current.provider).toEqual({ known: true, value: null });
      expect(current.capability).toMatchObject({
        status: "ONLINE",
        connection: { status: "NOT_CONNECTED" },
      });
    }),
  );

  it.effect("preserves a confirmed provider when a live refresh falls back offline", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-" });
      const account = user("user_1");
      const runtime = makeRuntime(cwd, { [account.id]: [] });

      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) =>
            localState.update({
              kind: "online",
              account,
              accountStatus: onlineAccount,
              connection: connected,
            }),
          ),
        ),
      );
      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "offline", account })),
        ),
      );
      const current = yield* Effect.promise(() =>
        runtime.runPromise(LocalState.use((localState) => localState.current)),
      );
      yield* Effect.promise(() => runtime.dispose());

      expect(current.provider).toEqual({ known: true, value: "GOOGLE_DRIVE" });
      expect(current.capability).toEqual({ status: "OFFLINE" });
    }),
  );

  it.effect("keeps a switched account hidden when its snippets cannot materialize", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-" });
      const firstAccount = user("user_1");
      const secondAccount = user("user_2");
      const firstSnippet = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "first.txt");
      const localStateSnippets = Layer.succeed(
        LocalStateSnippets,
        LocalStateSnippets.of({
          changes: Stream.empty,
          read: (accountId) =>
            accountId === secondAccount.id
              ? Effect.fail(
                  new LocalStateError({
                    cause: null,
                    reason: "simulated materialization failure",
                  }),
                )
              : Effect.succeed([firstSnippet]),
        }),
      );
      const runtime = ManagedRuntime.make(
        LocalStateLive.pipe(
          Layer.provide(Layer.merge(makeLocalStateStoreLive({ cwd }), localStateSnippets)),
        ),
      );

      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) =>
            localState.update({ kind: "offline", account: firstAccount }),
          ),
        ),
      );
      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "owner-cleanup-pending" })),
        ),
      );
      const switched = yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) =>
            localState.update({ kind: "offline", account: secondAccount }),
          ).pipe(Effect.result),
        ),
      );
      const current = yield* Effect.promise(() =>
        runtime.runPromise(LocalState.use((localState) => localState.current)),
      );
      yield* Effect.promise(() => runtime.dispose());

      expect(switched._tag).toBe("Failure");
      expect(current).toMatchObject({
        account: null,
        provider: { known: false, value: null },
        capability: { status: "OFFLINE" },
        snippets: [],
      });
    }),
  );

  it.effect("keeps a cleanup-pending account hidden after a restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-" });
      const account = user("user_1");
      const retainedSnippet = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "retained.txt");

      const runtime = makeRuntime(cwd, { [account.id]: [retainedSnippet] });
      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) =>
            localState.update({
              kind: "online",
              account,
              accountStatus: onlineAccount,
              connection: connected,
            }),
          ),
        ),
      );
      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "owner-cleanup-pending" })),
        ),
      );
      const hiddenDuringCleanup = yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) =>
            localState.refresh.pipe(Effect.andThen(localState.current)),
          ),
        ),
      );
      yield* Effect.promise(() => runtime.dispose());

      const restartedRuntime = makeRuntime(cwd, { [account.id]: [retainedSnippet] });
      const restored = yield* Effect.promise(() =>
        restartedRuntime.runPromise(
          LocalState.use((localState) =>
            Effect.all({ current: localState.current, owner: localState.owner }),
          ),
        ),
      );
      yield* Effect.promise(() => restartedRuntime.dispose());

      expect(restored.current).toMatchObject({
        account: null,
        provider: { known: false, value: null },
        capability: { status: "OFFLINE" },
        snippets: [],
      });
      expect(hiddenDuringCleanup).toMatchObject({
        account: null,
        provider: { known: false, value: null },
        capability: { status: "OFFLINE" },
        snippets: [],
      });
      expect(restored.owner).toEqual({ account, cleanupPending: true });
    }),
  );

  it.effect("clears durable local state on explicit sign-out", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-" });
      const account = user("user_1");
      const runtime = makeRuntime(cwd, { [account.id]: [] });

      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) =>
            localState.update({
              kind: "online",
              account,
              accountStatus: onlineAccount,
              connection: connected,
            }),
          ),
        ),
      );
      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "signed-out" })),
        ),
      );
      yield* Effect.promise(() => runtime.dispose());

      const restartedRuntime = makeRuntime(cwd, { [account.id]: [] });
      const restored = yield* Effect.promise(() =>
        restartedRuntime.runPromise(LocalState.use((localState) => localState.current)),
      );
      yield* Effect.promise(() => restartedRuntime.dispose());

      expect(restored).toMatchObject({
        account: null,
        provider: { known: false, value: null },
        capability: { status: "OFFLINE" },
        snippets: [],
      });
    }),
  );

  it.effect("recovers from an invalid cached session without failing desktop startup", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-" });
      const store = new ElectronStore<{ session: string | null }>({
        cwd,
        name: "local-state",
      });
      store.set("session", "not a valid encoded session");

      const runtime = makeRuntime(cwd, {});
      const localState = yield* Effect.promise(() =>
        runtime.runPromise(LocalState.use((desktop) => desktop.current)),
      );
      yield* Effect.promise(() => runtime.dispose());

      expect(localState).toEqual({
        revision: 0,
        account: null,
        provider: { known: false, value: null },
        capability: { status: "OFFLINE" },
        snippets: [],
      });
      expect(store.get("session")).toBeNull();
    }),
  );

  it.effect("migrates the previously named durable store without losing offline state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-" });
      const account = user("user_1");
      const legacyStore = new ElectronStore<{ session: string | null }>({
        cwd,
        name: "desktop-projection",
      });
      const encode = Schema.encodeSync(Schema.fromJsonString(CachedLocalStateSessionSchema));
      legacyStore.set(
        "session",
        encode({
          account,
          provider: { known: true, value: "GOOGLE_DRIVE" },
          cleanupPending: false,
        }),
      );

      const runtime = makeRuntime(cwd, { [account.id]: [] });
      const localState = yield* Effect.promise(() =>
        runtime.runPromise(LocalState.use((state) => state.current)),
      );
      yield* Effect.promise(() => runtime.dispose());

      expect(localState).toMatchObject({
        account,
        provider: { known: true, value: "GOOGLE_DRIVE" },
        capability: { status: "OFFLINE" },
      });
      expect(legacyStore.get("session")).toBeNull();
    }),
  );

  it.effect("migrates the released active-account store with unknown provider state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-" });
      const account = user("user_1");
      const legacyStore = new ElectronStore<{ active: string | null }>({
        cwd,
        defaults: { active: null },
        name: "snippet-replica-account",
      });
      legacyStore.set("active", Schema.encodeSync(Schema.fromJsonString(UserSchema))(account));

      const runtime = makeRuntime(cwd, { [account.id]: [] });
      const localState = yield* Effect.promise(() =>
        runtime.runPromise(LocalState.use((state) => state.current)),
      );
      yield* Effect.promise(() => runtime.dispose());

      expect(localState).toMatchObject({
        account,
        provider: { known: false, value: null },
        capability: { status: "OFFLINE" },
      });
      expect(legacyStore.get("active")).toBeNull();
    }),
  );

  it.effect("cannot resurrect a stale released account after explicit sign-out", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-" });
      const account = user("user_1");
      const encodeSession = Schema.encodeSync(Schema.fromJsonString(CachedLocalStateSessionSchema));
      const currentStore = new ElectronStore<{ session: string | null }>({
        cwd,
        name: "local-state",
      });
      currentStore.set(
        "session",
        encodeSession({
          account,
          provider: { known: true, value: "GOOGLE_DRIVE" },
          cleanupPending: false,
        }),
      );
      const releasedStore = new ElectronStore<{ active: string | null }>({
        cwd,
        defaults: { active: null },
        name: "snippet-replica-account",
      });
      releasedStore.set("active", Schema.encodeSync(Schema.fromJsonString(UserSchema))(account));

      const runtime = makeRuntime(cwd, { [account.id]: [] });
      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "signed-out" })),
        ),
      );
      yield* Effect.promise(() => runtime.dispose());

      const restartedRuntime = makeRuntime(cwd, { [account.id]: [] });
      const restarted = yield* Effect.promise(() =>
        restartedRuntime.runPromise(LocalState.use((localState) => localState.current)),
      );
      yield* Effect.promise(() => restartedRuntime.dispose());

      expect(releasedStore.get("active")).toBeNull();
      expect(restarted.account).toBeNull();
      expect(restarted.snippets).toEqual([]);
    }),
  );
});
