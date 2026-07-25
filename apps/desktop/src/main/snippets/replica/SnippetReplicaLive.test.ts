import { NodeFileSystem } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { join } from "node:path";
import { Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeDesktopSqliteLayer } from "../../persistence/Sqlite.ts";
import {
  SnippetReplica,
  type LocalUploadRecord,
  type PublishedSnippetRecord,
} from "./SnippetReplica.ts";
import { SnippetReplicaLive } from "./SnippetReplicaLive.ts";

const accountId = "user_1";
const published: PublishedSnippetRecord = {
  kind: "PUBLISHED",
  snippet: {
    id: "0d1e2f3a-4567-4890-8abc-def012345678",
    fileName: "published.txt",
    byteSize: 12,
    storageProvider: "GOOGLE_DRIVE",
    storageObjectId: "drive-id",
    createdAt: "2026-07-10T20:00:00.000Z",
    updatedAt: "2026-07-10T20:00:01.000Z",
  },
};
const local: LocalUploadRecord = {
  kind: "LOCAL",
  id: "1d1e2f3a-4567-4890-8abc-def012345679",
  fileName: "uploading.txt",
  byteSize: 24,
  storageProvider: "GOOGLE_DRIVE",
  status: "UPLOADING",
  errorMessage: null,
  createdAt: "2026-07-10T20:00:02.000Z",
  updatedAt: "2026-07-10T20:00:03.000Z",
};

const withReplica = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SnippetReplica | SqlClient.SqlClient>,
) => {
  const sqliteLayer = makeDesktopSqliteLayer(databasePath);
  return effect.pipe(Effect.provide(SnippetReplicaLive.pipe(Layer.provideMerge(sqliteLayer))));
};

it.layer(NodeFileSystem.layer)("SQLite snippet replica", (it) => {
  it.effect("persists ordered records and empty replicas across database restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-sqlite-replica-" });
      const databasePath = join(cwd, "plakk.sqlite");

      yield* withReplica(
        databasePath,
        Effect.gen(function* () {
          const replica = yield* SnippetReplica;
          expect(yield* replica.get(accountId)).toBeNull();
          yield* replica.commit(accountId, { items: [published] });
          yield* replica.update(accountId, (state) => ({
            items: [...state.items, local],
          }));
        }),
      );

      const restarted = yield* withReplica(
        databasePath,
        SnippetReplica.use((replica) => replica.get(accountId)),
      );
      expect(restarted).toEqual({ items: [published, local] });

      yield* withReplica(
        databasePath,
        SnippetReplica.use((replica) =>
          replica
            .remove(accountId, published.snippet.id)
            .pipe(Effect.andThen(replica.commit(accountId, { items: [] }))),
        ),
      );

      const empty = yield* withReplica(
        databasePath,
        SnippetReplica.use((replica) => replica.get(accountId)),
      );
      expect(empty).toEqual({ items: [] });

      yield* withReplica(
        databasePath,
        SnippetReplica.use((replica) => replica.purge(accountId)),
      );
      const purged = yield* withReplica(
        databasePath,
        SnippetReplica.use((replica) => replica.get(accountId)),
      );
      expect(purged).toBeNull();
    }),
  );

  it.effect("rejects the superseded authoritative upload-status shape", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-sqlite-replica-" });
      const databasePath = join(cwd, "plakk.sqlite");

      const error = yield* withReplica(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const replica = yield* SnippetReplica;
          const legacyRecord = JSON.stringify({
            id: "0d1e2f3a-4567-4890-8abc-def012345678",
            fileName: "legacy.txt",
            byteSize: 12,
            storageProvider: "GOOGLE_DRIVE",
            storageObjectId: "drive-id",
            uploadStatus: "UPLOADED",
            createdAt: "2026-07-10T20:00:00.000Z",
            updatedAt: "2026-07-10T20:00:01.000Z",
          });

          yield* sql`
            INSERT INTO snippet_replicas (account_id)
            VALUES (${accountId})
          `;
          yield* sql`
            INSERT INTO snippet_replica_items (
              account_id,
              snippet_id,
              position,
              record_json
            )
            VALUES (
              ${accountId},
              ${"0d1e2f3a-4567-4890-8abc-def012345678"},
              ${0},
              ${legacyRecord}
            )
          `;

          return yield* Effect.flip(replica.get(accountId));
        }),
      );

      expect(error.reason).toBe("Stored snippet replica is invalid.");
    }),
  );
});
