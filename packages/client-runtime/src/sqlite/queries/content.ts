import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isPublishedSnippet } from "../../models/Snippet.ts";
import { listSnippets } from "./snippets.ts";

export type ContentStatus = "AVAILABLE" | "NOT_AVAILABLE" | "DOWNLOADING" | "FAILED";

/** Reads only snippets whose backend publication has completed. */
export const listPublishedSnippets = Effect.fn("ClientQueries.listPublishedSnippets")(function* (
  userId: string,
) {
  return (yield* listSnippets(userId)).filter(isPublishedSnippet);
});

/** Records the device-local availability of a published snippet's bytes. */
export const setContentStatus = Effect.fn("ClientQueries.setContentStatus")(function* (
  userId: string,
  snippetId: string,
  status: ContentStatus,
  errorMessage: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO client_local_files (
      user_id,
      snippet_id,
      status,
      error_message
    )
    VALUES (${userId}, ${snippetId}, ${status}, ${errorMessage})
    ON CONFLICT (user_id, snippet_id) DO UPDATE SET
      status = excluded.status,
      error_message = excluded.error_message
  `;
});
