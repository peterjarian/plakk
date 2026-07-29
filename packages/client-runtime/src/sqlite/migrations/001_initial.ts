import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Creates the initial local snippet and local-content tables. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE client_snippets (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      storage_provider TEXT NOT NULL,
      media_type TEXT,
      storage_object_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('PREPARING', 'UPLOADING', 'FAILED', 'PUBLISHED')),
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, id),
      CHECK (
        (
          status IN ('PREPARING', 'UPLOADING')
          AND storage_object_id IS NULL
          AND error_message IS NULL
        )
        OR
        (
          status = 'FAILED'
          AND storage_object_id IS NULL
          AND error_message IS NOT NULL
        )
        OR
        (
          status = 'PUBLISHED'
          AND storage_object_id IS NOT NULL
          AND error_message IS NULL
        )
      )
    )
  `;

  yield* sql`
    CREATE TABLE client_local_files (
      user_id TEXT NOT NULL,
      snippet_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('AVAILABLE', 'NOT_AVAILABLE', 'DOWNLOADING', 'FAILED')
      ),
      error_message TEXT,
      PRIMARY KEY (user_id, snippet_id),
      FOREIGN KEY (user_id, snippet_id)
        REFERENCES client_snippets(user_id, id)
        ON DELETE CASCADE
    )
  `;
});
