import ElectronStore from "electron-store";
import { Effect, Layer, PubSub, Schema, Semaphore, Stream } from "effect";
import { StorageProviderLiteral } from "@plakk/shared";
import { SnippetIdSchema } from "@plakk/shared/PlakkApi";

import {
  SnippetReplica,
  SnippetReplicaError,
  SnippetReplicaStateSchema,
  deviceSnippetRecordId,
  type SnippetReplicaState,
} from "./SnippetReplica.ts";

const StoredReplicaCodec = Schema.fromJsonString(SnippetReplicaStateSchema);
const LegacyStoredReplicaCodec = Schema.fromJsonString(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        id: SnippetIdSchema,
        fileName: Schema.String,
        byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        storageProvider: StorageProviderLiteral,
        storageObjectId: Schema.NullOr(Schema.String),
        uploadStatus: Schema.Literals([
          "UPLOADING",
          "FAILED",
          "CLIENT_UPLOAD_FAILED",
          "UPLOADED",
        ] as const),
        createdAt: Schema.String,
        updatedAt: Schema.String,
      }),
    ),
  }),
);

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
        Effect.catch(() =>
          Schema.decodeEffect(LegacyStoredReplicaCodec)(json).pipe(
            Effect.map(
              (legacy): SnippetReplicaState => ({
                items: legacy.items.flatMap((snippet) => {
                  if (snippet.uploadStatus !== "UPLOADED" || snippet.storageObjectId === null) {
                    return [];
                  }
                  return [
                    {
                      kind: "PUBLISHED" as const,
                      snippet: {
                        id: snippet.id,
                        fileName: snippet.fileName,
                        byteSize: snippet.byteSize,
                        storageProvider: snippet.storageProvider,
                        storageObjectId: snippet.storageObjectId,
                        createdAt: snippet.createdAt,
                        updatedAt: snippet.updatedAt,
                      },
                    },
                  ];
                }),
              }),
            ),
          ),
        ),
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
      update: (accountId, transform) =>
        lock.withPermit(
          Effect.gen(function* () {
            const current = (yield* readReplica(accountId)) ?? { items: [] };
            const next = transform(current);
            yield* writeReplica(accountId, next);
            yield* PubSub.publish(changes, { accountId, items: next.items });
            return next;
          }),
        ),
      purge: (accountId) =>
        lock.withPermit(
          Effect.gen(function* () {
            yield* Effect.try({
              try: () => {
                store.delete(accountId);
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
            const nextState: SnippetReplicaState = {
              ...state,
              items: state.items.filter((record) => deviceSnippetRecordId(record) !== snippetId),
            };
            yield* writeReplica(accountId, nextState);
            yield* PubSub.publish(changes, { accountId, items: nextState.items });
          }),
        ),
    });
  }),
);
