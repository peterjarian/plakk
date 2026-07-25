import { Effect } from "effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const createSnippetReplicaTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE snippet_replicas (
      account_id TEXT PRIMARY KEY NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE snippet_replica_items (
      account_id TEXT NOT NULL,
      snippet_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      record_json TEXT NOT NULL,
      PRIMARY KEY (account_id, snippet_id),
      UNIQUE (account_id, position),
      FOREIGN KEY (account_id) REFERENCES snippet_replicas(account_id) ON DELETE CASCADE
    )
  `;
});

const migrationLoader = Migrator.fromRecord({
  "1_create_snippet_replica_tables": createSnippetReplicaTables,
});

const migrate = Migrator.make({});

export const runDesktopMigrations = migrate({ loader: migrationLoader });
