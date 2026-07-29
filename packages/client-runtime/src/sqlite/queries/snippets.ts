import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { SnippetSchema } from "../../models/Snippet.ts";

const SnippetRowSchema = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  title: Schema.NullOr(Schema.String),
  byteSize: Schema.Finite,
  storageProvider: Schema.String,
  mediaType: Schema.NullOr(Schema.String),
  storageObjectId: Schema.NullOr(Schema.String),
  status: Schema.String,
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  localContentStatus: Schema.NullOr(Schema.String),
  localContentErrorMessage: Schema.NullOr(Schema.String),
});

/** Reads the current user's snippets in newest-first order. */
export const listSnippets = Effect.fn("ClientQueries.listSnippets")(function* (userId: string) {
  const sql = yield* SqlClient.SqlClient;
  const select = SqlSchema.findAll({
    Request: Schema.String,
    Result: SnippetRowSchema,
    execute: (id) => sql`
      SELECT
        snippets.id,
        snippets.file_name AS "fileName",
        snippets.title,
        snippets.byte_size AS "byteSize",
        snippets.storage_provider AS "storageProvider",
        snippets.media_type AS "mediaType",
        snippets.storage_object_id AS "storageObjectId",
        snippets.status,
        snippets.error_message AS "errorMessage",
        snippets.created_at AS "createdAt",
        snippets.updated_at AS "updatedAt",
        content.status AS "localContentStatus",
        content.error_message AS "localContentErrorMessage"
      FROM client_snippets AS snippets
      LEFT JOIN client_local_files AS content
        ON content.user_id = snippets.user_id
        AND content.snippet_id = snippets.id
      WHERE snippets.user_id = ${id}
      ORDER BY snippets.created_at DESC, snippets.id DESC
    `,
  });

  const rows = yield* select(userId);
  return yield* Effect.forEach(rows, (row) => {
    const { title, localContentStatus, localContentErrorMessage, ...snippet } = row;
    const localContentAvailability =
      localContentStatus === "FAILED"
        ? {
            status: "FAILED" as const,
            message: localContentErrorMessage ?? "Local content is unavailable.",
          }
        : localContentStatus === "AVAILABLE" || localContentStatus === "DOWNLOADING"
          ? { status: localContentStatus }
          : { status: "NOT_AVAILABLE" as const };

    return Schema.decodeUnknownEffect(SnippetSchema)({
      ...snippet,
      ...(title === null ? {} : { title }),
      localContentAvailability,
    });
  });
});

/** Removes a snippet after its remote deletion has succeeded. */
export const removeSnippet = Effect.fn("ClientQueries.removeSnippet")(function* (
  userId: string,
  snippetId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM client_snippets
    WHERE user_id = ${userId}
      AND id = ${snippetId}
  `;
});

/** Removes every locally stored snippet record owned by one user. */
export const clearSnippets = Effect.fn("ClientQueries.clearSnippets")(function* (userId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM client_snippets
    WHERE user_id = ${userId}
  `;
});
