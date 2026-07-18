import {
  ManagedSnippetContent,
  SnippetRemoteTransport,
  SnippetReplica,
  SnippetReplicaError,
  SnippetReplicaStateSchema,
  type SnippetReplicaState,
} from "@plakk/shared/SnippetReplica";
import ElectronStore from "electron-store";
import { Effect, Layer, PubSub, Schema, Semaphore, Stream } from "effect";
import type { SnippetChangePage } from "@plakk/shared/PlakkApi";

import { PlakkRpcClient } from "./PlakkRpcClient.ts";

const StoredReplicaCodec = Schema.fromJsonString(SnippetReplicaStateSchema);
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

    return SnippetReplica.of({
      changes: Stream.fromPubSub(changes),
      get: (accountId) => lock.withPermit(readReplica(accountId)),
      commit: (accountId, state) =>
        lock.withPermit(
          Effect.gen(function* () {
            yield* writeReplica(accountId, state);
            yield* PubSub.publish(changes, { accountId, items: state.items });
          }),
        ),
      purge: (accountId) =>
        lock.withPermit(
          Effect.gen(function* () {
            yield* Effect.try({
              try: () => {
                store.delete(accountId);
                store.delete(`pending-deletes:${accountId}`);
              },
              catch: (cause) =>
                new SnippetReplicaError({
                  cause,
                  reason: "Could not purge the snippet replica.",
                }),
            });
            yield* PubSub.publish(changes, { accountId, items: [] });
          }),
        ),
      remove: (accountId, snippetId) =>
        lock.withPermit(
          Effect.gen(function* () {
            const state = yield* readReplica(accountId);
            if (state === null) return;
            const nextState = {
              ...state,
              items: state.items.filter((snippet) => snippet.id !== snippetId),
            };
            yield* writeReplica(accountId, nextState);
            yield* PubSub.publish(changes, { accountId, items: nextState.items });
          }),
        ),
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
