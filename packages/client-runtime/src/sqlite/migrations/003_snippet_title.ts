import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Adds the optional content-derived title stored with each local snippet. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE client_snippets
    ADD COLUMN title TEXT
  `;
});
