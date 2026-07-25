import ElectronStore from "electron-store";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Option, PubSub, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  DeviceSnippetRecordSchema,
  SnippetReplica,
  SnippetReplicaError,
  SnippetReplicaStateSchema,
  deviceSnippetRecordId,
  type SnippetReplicaState,
} from "./SnippetReplica.ts";

const StoredReplicaCodec = Schema.fromJsonString(SnippetReplicaStateSchema);
const StoredRecordCodec = Schema.fromJsonString(DeviceSnippetRecordSchema);
const LegacyImportKey = "electron-store/snippet-replicas";

const ReplicaItemRowSchema = Schema.Struct({
  recordJson: Schema.String,
});

type LegacyStore = ElectronStore<Record<string, string>>;

export const decodeStoredSnippetReplica = (json: string) =>
  Schema.decodeEffect(StoredReplicaCodec)(json).pipe(
    Effect.mapError(
      (cause) =>
        new SnippetReplicaError({
          cause,
          reason: "Stored snippet replica is invalid.",
        }),
    ),
  );

const openLegacyStore = (cwd: string) =>
  Effect.try({
    try: () =>
      new ElectronStore<Record<string, string>>({
        accessPropertiesByDotNotation: false,
        cwd,
        name: "snippet-replicas",
      }),
    catch: (cause) =>
      new SnippetReplicaError({
        cause,
        reason: "Could not open the legacy snippet replica.",
      }),
  });

const readLegacyReplicas = (store: LegacyStore) =>
  Effect.try({
    try: () => Object.entries(store.store),
    catch: (cause) =>
      new SnippetReplicaError({
        cause,
        reason: "Could not read the legacy snippet replica.",
      }),
  }).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(entries, ([accountId, json]) =>
        decodeStoredSnippetReplica(json).pipe(
          Effect.map((state) => Option.some([accountId, state] as const)),
          Effect.catch((error) =>
            Effect.logWarning("Discarded an invalid legacy snippet replica", { error }).pipe(
              Effect.as(Option.none()),
            ),
          ),
        ),
      ).pipe(Effect.map((results) => results.filter(Option.isSome).map(({ value }) => value))),
    ),
  );

const clearLegacyReplicas = (store: LegacyStore) =>
  Effect.try({
    try: () => store.clear(),
    catch: (cause) =>
      new SnippetReplicaError({
        cause,
        reason: "Could not clear the migrated legacy snippet replica.",
      }),
  });

export const makeSnippetReplicaLive = (options: { readonly legacyStoreCwd: string }) =>
  Layer.effect(
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
        const rows = yield* readReplicaRows(accountId);
        const items = yield* Effect.forEach(rows, ({ recordJson }) =>
          Schema.decodeEffect(StoredRecordCodec)(recordJson),
        );
        return { items } satisfies SnippetReplicaState;
      });

      const encodeReplica = Effect.fn("DesktopSnippetReplica.encode")(function* (
        state: SnippetReplicaState,
      ) {
        return yield* Effect.forEach(state.items, (record, position) =>
          Schema.encodeEffect(StoredRecordCodec)(record).pipe(
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
        readReplicaSql(accountId).pipe(
          Effect.mapError(
            (cause) =>
              new SnippetReplicaError({
                cause,
                reason: "Could not read the snippet replica.",
              }),
          ),
        ),
      );

      const hasLegacyImport = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ key: Schema.String }),
        execute: (key) =>
          sql`
          SELECT key
          FROM desktop_data_migrations
          WHERE key = ${key}
        `,
      });

      const importLegacyReplicas = Effect.fn("DesktopSnippetReplica.importLegacy")(function* () {
        const legacyPath = join(options.legacyStoreCwd, "snippet-replicas.json");
        const legacyExists = yield* Effect.try({
          try: () => existsSync(legacyPath),
          catch: (cause) =>
            new SnippetReplicaError({
              cause,
              reason: "Could not inspect the legacy snippet replica.",
            }),
        });
        const legacyStore = legacyExists ? yield* openLegacyStore(options.legacyStoreCwd) : null;
        const alreadyImported = Option.isSome(yield* hasLegacyImport(LegacyImportKey));

        if (!alreadyImported) {
          const entries = legacyStore === null ? [] : yield* readLegacyReplicas(legacyStore);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              for (const [accountId, state] of entries) {
                const existing = yield* sql`
                SELECT account_id
                FROM snippet_replicas
                WHERE account_id = ${accountId}
              `;
                if (existing.length > 0) continue;
                const encoded = yield* encodeReplica(state);
                yield* writeReplicaSql(accountId, encoded);
              }
              yield* sql`
              INSERT INTO desktop_data_migrations (key)
              VALUES (${LegacyImportKey})
            `;
            }),
          );
        }

        if (legacyStore !== null) {
          yield* clearLegacyReplicas(legacyStore).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not clear migrated legacy snippet replicas", { error }),
            ),
          );
        }
      });

      yield* importLegacyReplicas();

      return SnippetReplica.of({
        changes: Stream.fromPubSub(changes),
        get: readReplica,
        commit: (accountId, state) =>
          Effect.gen(function* () {
            const encoded = yield* encodeReplica(state);
            yield* sql.withTransaction(writeReplicaSql(accountId, encoded));
            yield* PubSub.publish(changes, { accountId, items: state.items });
          }).pipe(
            Effect.mapError(
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
              Effect.mapError(
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
              Effect.mapError(
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
