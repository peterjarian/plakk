import { type ApiSnippet, type PrepareSnippetUploadPayload } from "@plakk/shared/PlakkApi";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export class SnippetAlreadyExistsError extends Schema.TaggedErrorClass<SnippetAlreadyExistsError>()(
  "SnippetAlreadyExistsError",
  {
    snippetId: Schema.String,
    message: Schema.String,
  },
) {}

/** Persists a preparing local snippet before any remote upload work begins. */
export const createPreparingSnippet = Effect.fn("ClientQueries.createPreparingSnippet")(function* (
  userId: string,
  input: PrepareSnippetUploadPayload,
  createdAt: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const findExisting = SqlSchema.findAll({
    Request: Schema.Struct({ userId: Schema.String, snippetId: Schema.String }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ userId: ownerId, snippetId }) => sql`
      SELECT id
      FROM client_snippets
      WHERE user_id = ${ownerId}
        AND id = ${snippetId}
    `,
  });

  yield* sql.withTransaction(
    Effect.gen(function* () {
      if ((yield* findExisting({ userId, snippetId: input.id })).length > 0) {
        return yield* new SnippetAlreadyExistsError({
          snippetId: input.id,
          message: "This snippet already exists.",
        });
      }

      yield* sql`
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
          ${input.id},
          ${input.fileName},
          ${input.byteSize},
          ${input.storageProvider},
          ${input.mediaType},
          NULL,
          'PREPARING',
          NULL,
          ${createdAt},
          ${createdAt}
        )
      `;
    }),
  );
});

/** Marks a preparing upload as actively transferring. */
export const markSnippetUploading = Effect.fn("ClientQueries.markSnippetUploading")(function* (
  userId: string,
  snippetId: string,
  updatedAt: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE client_snippets
    SET
      status = 'UPLOADING',
      updated_at = ${updatedAt}
    WHERE user_id = ${userId}
      AND id = ${snippetId}
      AND status = 'PREPARING'
  `;
});

/** Returns a temporarily blocked upload to its preparing state. */
export const markSnippetPreparing = Effect.fn("ClientQueries.markSnippetPreparing")(function* (
  userId: string,
  snippetId: string,
  updatedAt: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE client_snippets
    SET
      status = 'PREPARING',
      updated_at = ${updatedAt}
    WHERE user_id = ${userId}
      AND id = ${snippetId}
      AND status = 'UPLOADING'
  `;
});

/** Marks a local upload as failed without discarding the visible snippet. */
export const markSnippetUploadFailed = Effect.fn("ClientQueries.markSnippetUploadFailed")(
  function* (userId: string, snippetId: string, updatedAt: string, message: string) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE client_snippets
      SET
        status = 'FAILED',
        storage_object_id = NULL,
        error_message = ${message},
        updated_at = ${updatedAt}
      WHERE user_id = ${userId}
        AND id = ${snippetId}
        AND status IN ('PREPARING', 'UPLOADING')
    `;
  },
);

/** Replaces an uploading local snippet with its published backend state. */
export const markSnippetPublished = Effect.fn("ClientQueries.markSnippetPublished")(function* (
  userId: string,
  snippet: ApiSnippet,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE client_snippets
    SET
      file_name = ${snippet.fileName},
      byte_size = ${snippet.byteSize},
      storage_provider = ${snippet.storageProvider},
      storage_object_id = ${snippet.storageObjectId},
      status = 'PUBLISHED',
      error_message = NULL,
      created_at = ${snippet.createdAt},
      updated_at = ${snippet.updatedAt}
    WHERE user_id = ${userId}
      AND id = ${snippet.id}
  `;
});

/** Makes uploads interrupted by the previous process visible as terminal failures. */
export const failInterruptedUploads = Effect.fn("ClientQueries.failInterruptedUploads")(function* (
  userId: string,
  updatedAt: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      UPDATE client_snippets
      SET
        status = 'FAILED',
        error_message = 'This upload was interrupted.',
        updated_at = ${updatedAt}
      WHERE user_id = ${userId}
        AND status IN ('PREPARING', 'UPLOADING')
    `;
});

/** Permanently removes a failed local snippet dismissed by the user. */
export const discardFailedSnippet = Effect.fn("ClientQueries.discardFailedSnippet")(function* (
  userId: string,
  snippetId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const remove = SqlSchema.findAll({
    Request: Schema.Struct({ userId: Schema.String, snippetId: Schema.String }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ userId: ownerId, snippetId: id }) => sql`
      DELETE FROM client_snippets
      WHERE user_id = ${ownerId}
        AND id = ${id}
        AND status = 'FAILED'
      RETURNING id
    `,
  });

  return (yield* remove({ userId, snippetId })).length > 0;
});
