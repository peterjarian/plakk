import { SnippetIdSchema, type ApiSnippet } from "@plakk/shared/PlakkApi";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/** Applies the backend snapshot atomically while preserving unpublished snippets. */
export const applySnippetSnapshot = Effect.fn("ClientQueries.applySnippetSnapshot")(function* (
  userId: string,
  snapshot: ReadonlyArray<ApiSnippet>,
) {
  const sql = yield* SqlClient.SqlClient;
  const selectPublishedIds = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ id: SnippetIdSchema }),
    execute: (id) => sql`
      SELECT id
      FROM client_snippets
      WHERE user_id = ${id}
        AND status = 'PUBLISHED'
    `,
  });

  yield* sql.withTransaction(
    Effect.gen(function* () {
      const current = yield* selectPublishedIds(userId);

      yield* Effect.forEach(
        snapshot,
        (snippet) => sql`
          INSERT INTO client_snippets (
            user_id,
            id,
            file_name,
            byte_size,
            storage_provider,
            media_type,
            storage_object_id,
            status,
            error_message,
            created_at,
            updated_at
          )
          VALUES (
            ${userId},
            ${snippet.id},
            ${snippet.fileName},
            ${snippet.byteSize},
            ${snippet.storageProvider},
            NULL,
            ${snippet.storageObjectId},
            'PUBLISHED',
            NULL,
            ${snippet.createdAt},
            ${snippet.updatedAt}
          )
          ON CONFLICT (user_id, id) DO UPDATE SET
            file_name = excluded.file_name,
            byte_size = excluded.byte_size,
            storage_provider = excluded.storage_provider,
            storage_object_id = excluded.storage_object_id,
            status = 'PUBLISHED',
            error_message = NULL,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `,
        { discard: true },
      );

      const snapshotIds = new Set(snapshot.map((snippet) => snippet.id));
      yield* Effect.forEach(
        current,
        ({ id }) =>
          Effect.gen(function* () {
            if (snapshotIds.has(id)) return;
            yield* sql`
              DELETE FROM client_snippets
              WHERE user_id = ${userId}
                AND id = ${id}
                AND status = 'PUBLISHED'
            `;
          }),
        { discard: true },
      );
    }),
  );
});
