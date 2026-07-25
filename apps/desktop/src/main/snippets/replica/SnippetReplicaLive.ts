import { Effect, Layer, PubSub, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  DeviceSnippetRecordSchema,
  SnippetReplica,
  SnippetReplicaError,
  deviceSnippetRecordId,
  type SnippetReplicaState,
} from "./SnippetReplica.ts";

const StoredRecordCodec = Schema.fromJsonString(DeviceSnippetRecordSchema);

const ReplicaItemRowSchema = Schema.Struct({
  recordJson: Schema.String,
});

const invalidStoredReplica = (cause: unknown) =>
  new SnippetReplicaError({
    cause,
    reason: "Stored snippet replica is invalid.",
  });

const invalidReplica = (cause: unknown) =>
  new SnippetReplicaError({
    cause,
    reason: "Snippet replica is invalid.",
  });

export const SnippetReplicaLive = Layer.effect(
  SnippetReplica,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* PubSub.unbounded<{
      readonly accountId: string;
      readonly items: SnippetReplicaState["items"];
    }>();

    const readReplicaRows = SqlSchema.findAll({
      Request: Schema.String,
      Result: ReplicaItemRowSchema,
      execute: (accountId) =>
        sql`
          SELECT record_json AS "recordJson"
          FROM snippet_replica_items
          WHERE account_id = ${accountId}
          ORDER BY position ASC
        `,
    });

    const readReplicaSql = Effect.fn("DesktopSnippetReplica.readSql")(function* (
      accountId: string,
    ) {
      const replicas = yield* sql<{ readonly accountId: string }>`
        SELECT account_id AS "accountId"
        FROM snippet_replicas
        WHERE account_id = ${accountId}
      `;
      if (replicas.length === 0) return null;
      const rows = yield* readReplicaRows(accountId).pipe(
        Effect.catchTag("SchemaError", invalidStoredReplica),
      );
      const items = yield* Effect.forEach(rows, ({ recordJson }) =>
        Schema.decodeEffect(StoredRecordCodec)(recordJson).pipe(
          Effect.mapError(invalidStoredReplica),
        ),
      );
      return { items } satisfies SnippetReplicaState;
    });

    const encodeReplica = Effect.fn("DesktopSnippetReplica.encode")(function* (
      state: SnippetReplicaState,
    ) {
      return yield* Effect.forEach(state.items, (record, position) =>
        Schema.encodeEffect(StoredRecordCodec)(record).pipe(
          Effect.mapError(invalidReplica),
          Effect.map((recordJson) => ({
            position,
            recordJson,
            snippetId: deviceSnippetRecordId(record),
          })),
        ),
      );
    });

    const writeReplicaSql = Effect.fn("DesktopSnippetReplica.writeSql")(function* (
      accountId: string,
      encoded: ReadonlyArray<{
        readonly position: number;
        readonly recordJson: string;
        readonly snippetId: string;
      }>,
    ) {
      yield* sql`
        INSERT INTO snippet_replicas (account_id)
        VALUES (${accountId})
        ON CONFLICT (account_id) DO NOTHING
      `;
      yield* sql`
        DELETE FROM snippet_replica_items
        WHERE account_id = ${accountId}
      `;
      yield* Effect.forEach(
        encoded,
        ({ position, recordJson, snippetId }) =>
          sql`
            INSERT INTO snippet_replica_items (
              account_id,
              snippet_id,
              position,
              record_json
            )
            VALUES (${accountId}, ${snippetId}, ${position}, ${recordJson})
          `,
        { discard: true },
      );
    });

    const readReplica = Effect.fn("DesktopSnippetReplica.read")((accountId: string) =>
      sql.withTransaction(readReplicaSql(accountId)).pipe(
        Effect.catchTag(
          "SqlError",
          (cause) =>
            new SnippetReplicaError({
              cause,
              reason: "Could not read the snippet replica.",
            }),
        ),
      ),
    );

    return SnippetReplica.of({
      changes: Stream.fromPubSub(changes),
      get: readReplica,
      commit: (accountId, state) =>
        Effect.gen(function* () {
          const encoded = yield* encodeReplica(state);
          yield* sql.withTransaction(writeReplicaSql(accountId, encoded));
          yield* PubSub.publish(changes, { accountId, items: state.items });
        }).pipe(
          Effect.catchTag(
            "SqlError",
            (cause) =>
              new SnippetReplicaError({
                cause,
                reason: "Could not commit the snippet replica.",
              }),
          ),
        ),
      update: (accountId, transform) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const current = (yield* readReplicaSql(accountId)) ?? { items: [] };
              const next = transform(current);
              const encoded = yield* encodeReplica(next);
              yield* writeReplicaSql(accountId, encoded);
              return next;
            }),
          )
          .pipe(
            Effect.catchTag(
              "SqlError",
              (cause) =>
                new SnippetReplicaError({
                  cause,
                  reason: "Could not update the snippet replica.",
                }),
            ),
            Effect.tap((next) => PubSub.publish(changes, { accountId, items: next.items })),
          ),
      purge: (accountId) =>
        sql`
          DELETE FROM snippet_replicas
          WHERE account_id = ${accountId}
        `.pipe(
          Effect.mapError(
            (cause) =>
              new SnippetReplicaError({
                cause,
                reason: "Could not purge the snippet replica.",
              }),
          ),
          Effect.andThen(PubSub.publish(changes, { accountId, items: [] })),
        ),
      remove: (accountId, snippetId) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                DELETE FROM snippet_replica_items
                WHERE account_id = ${accountId}
                  AND snippet_id = ${snippetId}
              `;
              return yield* readReplicaSql(accountId);
            }),
          )
          .pipe(
            Effect.catchTag(
              "SqlError",
              (cause) =>
                new SnippetReplicaError({
                  cause,
                  reason: "Could not remove the snippet from the replica.",
                }),
            ),
            Effect.tap((state) =>
              state === null
                ? Effect.void
                : PubSub.publish(changes, { accountId, items: state.items }),
            ),
            Effect.asVoid,
          ),
    });
  }),
);
