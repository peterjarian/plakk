import { UserSchema, type User } from "@plakk/shared";
import {
  ManagedSnippetContent,
  SnippetRemoteTransport,
  SnippetReplica,
  SnippetReplicaError,
  SnippetReplicaStateSchema,
  type SnippetReplicaState,
} from "@plakk/shared/SnippetReplica";
import ElectronStore from "electron-store";
import { Context, Effect, Layer, PubSub, Schema, Semaphore, Stream } from "effect";
import { SnippetIdSchema, type SnippetChangePage } from "@plakk/shared/PlakkApi";

import { PlakkRpcClient } from "./PlakkRpcClient.ts";

const StoredReplicaCodec = Schema.fromJsonString(SnippetReplicaStateSchema);
const PendingReplicaDeleteSchema = Schema.Struct({
  id: SnippetIdSchema,
  remoteConfirmed: Schema.Boolean,
  cleanupComplete: Schema.Boolean,
});
type PendingReplicaDelete = typeof PendingReplicaDeleteSchema.Type;
const StoredPendingDeletesCodec = Schema.fromJsonString(Schema.Array(PendingReplicaDeleteSchema));
const StoredAccountCodec = Schema.fromJsonString(UserSchema);
const pendingDeletesKey = (accountId: string) => `pending-deletes:${accountId}`;
const maskPendingReplicaDeletes = (
  state: SnippetReplicaState,
  pendingDeletes: ReadonlyArray<PendingReplicaDelete>,
): SnippetReplicaState => {
  const pending = new Set(pendingDeletes.map((deletion) => deletion.id));
  return { ...state, items: state.items.filter((snippet) => !pending.has(snippet.id)) };
};

export const applyPendingReplicaDeletes = (
  state: SnippetReplicaState,
  pendingDeletes: ReadonlyArray<PendingReplicaDelete>,
) => {
  const incomingIds = new Set(state.items.map((snippet) => snippet.id));
  const updatedDeletes = pendingDeletes.map((deletion) => ({
    ...deletion,
    remoteConfirmed: deletion.remoteConfirmed || !incomingIds.has(deletion.id),
  }));
  return {
    state: maskPendingReplicaDeletes(state, pendingDeletes),
    pendingDeletes: updatedDeletes.filter(
      (deletion) =>
        !(deletion.remoteConfirmed && deletion.cleanupComplete && !incomingIds.has(deletion.id)),
    ),
  };
};

export const SnippetReplicaLive = Layer.effect(
  SnippetReplica,
  Effect.gen(function* () {
    const store = yield* Effect.try({
      try: () =>
        new ElectronStore<Record<string, string>>({
          accessPropertiesByDotNotation: false,
          name: "snippet-replicas",
        }),
      catch: (cause) =>
        new SnippetReplicaError({ cause, reason: "Could not open the snippet replica." }),
    });
    const changes = yield* PubSub.unbounded<{
      readonly accountId: string;
      readonly items: SnippetReplicaState["items"];
    }>();
    const lock = yield* Semaphore.make(1);

    const readReplica = Effect.fn("DesktopSnippetReplica.read")(function* (accountId: string) {
      const json = yield* Effect.try({
        try: () => store.get(accountId),
        catch: (cause) =>
          new SnippetReplicaError({ cause, reason: "Could not read the snippet replica." }),
      });
      if (json === undefined) return null;
      return yield* Schema.decodeEffect(StoredReplicaCodec)(json).pipe(
        Effect.mapError(
          (cause) =>
            new SnippetReplicaError({
              cause,
              reason: "Stored snippet replica is invalid.",
            }),
        ),
      );
    });

    const readPendingDeletes = Effect.fn("DesktopSnippetReplica.readPendingDeletes")(function* (
      accountId: string,
    ) {
      const json = yield* Effect.try({
        try: () => store.get(pendingDeletesKey(accountId)),
        catch: (cause) =>
          new SnippetReplicaError({ cause, reason: "Could not read pending snippet deletions." }),
      });
      if (json === undefined) return [];
      return yield* Schema.decodeEffect(StoredPendingDeletesCodec)(json).pipe(
        Effect.mapError(
          (cause) =>
            new SnippetReplicaError({
              cause,
              reason: "Stored pending snippet deletions are invalid.",
            }),
        ),
      );
    });

    const writeReplica = Effect.fn("DesktopSnippetReplica.write")(function* (
      accountId: string,
      state: SnippetReplicaState,
    ) {
      const json = yield* Schema.encodeEffect(StoredReplicaCodec)(state).pipe(
        Effect.mapError(
          (cause) => new SnippetReplicaError({ cause, reason: "Snippet replica is invalid." }),
        ),
      );
      yield* Effect.try({
        try: () => store.set(accountId, json),
        catch: (cause) =>
          new SnippetReplicaError({ cause, reason: "Could not commit the snippet replica." }),
      });
    });

    const writePendingDeletes = Effect.fn("DesktopSnippetReplica.writePendingDeletes")(function* (
      accountId: string,
      pendingDeletes: ReadonlyArray<PendingReplicaDelete>,
    ) {
      const key = pendingDeletesKey(accountId);
      const json = yield* Schema.encodeEffect(StoredPendingDeletesCodec)(pendingDeletes).pipe(
        Effect.mapError(
          (cause) =>
            new SnippetReplicaError({
              cause,
              reason: "Pending snippet deletions are invalid.",
            }),
        ),
      );
      yield* Effect.try({
        try: () => (pendingDeletes.length === 0 ? store.delete(key) : store.set(key, json)),
        catch: (cause) =>
          new SnippetReplicaError({ cause, reason: "Could not save pending snippet deletions." }),
      });
    });

    return SnippetReplica.of({
      changes: Stream.fromPubSub(changes),
      get: (accountId) =>
        lock.withPermit(
          Effect.gen(function* () {
            const state = yield* readReplica(accountId);
            if (state === null) return null;
            const pendingDeletes = yield* readPendingDeletes(accountId);
            return maskPendingReplicaDeletes(state, pendingDeletes);
          }),
        ),
      commit: (accountId, state) =>
        lock.withPermit(
          Effect.gen(function* () {
            const pendingDeletes = yield* readPendingDeletes(accountId);
            const next = applyPendingReplicaDeletes(state, pendingDeletes);
            yield* writeReplica(accountId, next.state);
            yield* writePendingDeletes(accountId, next.pendingDeletes);
            yield* PubSub.publish(changes, { accountId, items: next.state.items });
          }),
        ),
      remove: (accountId, snippetId) =>
        lock.withPermit(
          Effect.gen(function* () {
            const state = yield* readReplica(accountId);
            const pendingDeletes = yield* readPendingDeletes(accountId);
            const nextPendingDeletes = pendingDeletes.some((deletion) => deletion.id === snippetId)
              ? pendingDeletes
              : [
                  ...pendingDeletes,
                  { id: snippetId, remoteConfirmed: false, cleanupComplete: false },
                ];
            yield* writePendingDeletes(accountId, nextPendingDeletes);
            if (state === null) return;
            const nextState = {
              ...state,
              items: state.items.filter((snippet) => snippet.id !== snippetId),
            };
            yield* writeReplica(accountId, nextState);
            yield* PubSub.publish(changes, { accountId, items: nextState.items });
          }),
        ),
      pendingDeleteIds: (accountId) =>
        lock.withPermit(
          readPendingDeletes(accountId).pipe(
            Effect.map((pendingDeletes) => pendingDeletes.map((deletion) => deletion.id)),
          ),
        ),
      completeDeleteCleanup: (accountId, snippetId) =>
        lock.withPermit(
          Effect.gen(function* () {
            const pendingDeletes = yield* readPendingDeletes(accountId);
            const nextPendingDeletes = pendingDeletes
              .map((deletion) =>
                deletion.id === snippetId ? { ...deletion, cleanupComplete: true } : deletion,
              )
              .filter((deletion) => !(deletion.remoteConfirmed && deletion.cleanupComplete));
            yield* writePendingDeletes(accountId, nextPendingDeletes);
          }),
        ),
    });
  }),
);

export class ActiveSnippetAccount extends Context.Service<
  ActiveSnippetAccount,
  {
    readonly get: Effect.Effect<User | null, SnippetReplicaError>;
    set(user: User | null): Effect.Effect<void, SnippetReplicaError>;
  }
>()("plakk/main/ActiveSnippetAccount") {}

export const ActiveSnippetAccountLive = Layer.effect(
  ActiveSnippetAccount,
  Effect.gen(function* () {
    const store = yield* Effect.try({
      try: () =>
        new ElectronStore<{ active: string | null }>({
          defaults: { active: null },
          name: "snippet-replica-account",
        }),
      catch: (cause) =>
        new SnippetReplicaError({
          cause,
          reason: "Could not open the active snippet account.",
        }),
    });

    return ActiveSnippetAccount.of({
      get: Effect.try({
        try: () => store.get("active"),
        catch: (cause) =>
          new SnippetReplicaError({
            cause,
            reason: "Could not read the active snippet account.",
          }),
      }).pipe(
        Effect.flatMap((json) =>
          json === null
            ? Effect.succeed(null)
            : Schema.decodeEffect(StoredAccountCodec)(json).pipe(
                Effect.mapError(
                  (cause) =>
                    new SnippetReplicaError({
                      cause,
                      reason: "Stored active snippet account is invalid.",
                    }),
                ),
              ),
        ),
      ),
      set: Effect.fn("ActiveSnippetAccount.set")(function* (user) {
        const json =
          user === null
            ? null
            : yield* Schema.encodeEffect(StoredAccountCodec)(user).pipe(
                Effect.mapError(
                  (cause) =>
                    new SnippetReplicaError({
                      cause,
                      reason: "Active snippet account is invalid.",
                    }),
                ),
              );
        yield* Effect.try({
          try: () => store.set("active", json),
          catch: (cause) =>
            new SnippetReplicaError({
              cause,
              reason: "Could not save the active snippet account.",
            }),
        });
      }),
    });
  }),
);

export const SnippetRemoteTransportLive = Layer.effect(
  SnippetRemoteTransport,
  Effect.gen(function* () {
    const client = yield* PlakkRpcClient;
    return SnippetRemoteTransport.of({
      snapshot: Effect.fn("DesktopSnippetRemote.snapshot")(function* (account) {
        const snapshot = yield* client.GetSnippetSnapshot(undefined, {
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
        return snapshot;
      }),
      pull: Effect.fn("DesktopSnippetRemote.pull")(function* (account, cursor) {
        const page: SnippetChangePage = yield* client.PullSnippetChanges(
          { cursor, limit: 100 },
          { headers: { authorization: `Bearer ${account.accessToken}` } },
        );
        return page;
      }),
      wakes: (account) =>
        client
          .SubscribeSnippetChanges(undefined, {
            headers: { authorization: `Bearer ${account.accessToken}` },
          })
          .pipe(Stream.map(() => undefined)),
    });
  }),
);

export const getReplicaItems = Effect.fn("DesktopSnippetReplica.items")(function* (
  accountId: string,
) {
  const replica = yield* SnippetReplica;
  return (yield* replica.get(accountId))?.items ?? [];
});

export const getReplicaSnippet = Effect.fn("DesktopSnippetReplica.snippet")(function* (
  accountId: string,
  snippetId: string,
) {
  const snippet = (yield* getReplicaItems(accountId)).find((item) => item.id === snippetId);
  if (snippet === undefined) {
    return yield* new SnippetReplicaError({ cause: null, reason: "Snippet was not found." });
  }
  return snippet;
});

export const getManagedSnippetBytes = Effect.fn("DesktopSnippetReplica.content")(function* (
  account: { readonly id: string },
  snippetId: string,
  knownSnippet?: {
    readonly id: string;
    readonly fileName: string;
    readonly byteSize: number;
    readonly uploadStatus: "UPLOADING" | "FAILED" | "UPLOADED" | null;
  },
) {
  const content = yield* ManagedSnippetContent;
  const snippet = knownSnippet ?? (yield* getReplicaSnippet(account.id, snippetId));
  const available = yield* content.available(account.id, snippetId, snippet.byteSize);
  if (!available) {
    yield* content.invalidate(account.id, [snippetId]);
    return yield* new SnippetReplicaError({
      cause: null,
      reason: "Download this snippet before using it on this device.",
    });
  }
  const cached = yield* content.get(account.id, snippetId);
  if (cached?.byteLength === snippet.byteSize) return { bytes: cached, snippet };
  yield* content.invalidate(account.id, [snippetId]);
  return yield* new SnippetReplicaError({
    cause: null,
    reason: "Download this snippet before using it on this device.",
  });
});
