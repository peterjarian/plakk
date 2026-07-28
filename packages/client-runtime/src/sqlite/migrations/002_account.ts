import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Stores the last backend-confirmed storage provider for offline display. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE client_account (
      user_id TEXT PRIMARY KEY,
      storage_provider TEXT
    )
  `;
});
