import { StorageProviderLiteral, type StorageProvider } from "@plakk/shared";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const AccountRowSchema = Schema.Struct({
  storageProvider: Schema.NullOr(StorageProviderLiteral),
});

/** Reads the last backend-confirmed storage provider for one user. */
export const getStorageProvider = Effect.fn("ClientQueries.getStorageProvider")(function* (
  userId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const select = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AccountRowSchema,
    execute: (id) => sql`
      SELECT storage_provider AS "storageProvider"
      FROM client_account
      WHERE user_id = ${id}
    `,
  });
  const row = yield* select(userId);
  return Option.isSome(row)
    ? { known: true, value: row.value.storageProvider }
    : { known: false, value: null };
});

/** Saves the latest backend-confirmed storage provider for one user. */
export const setStorageProvider = Effect.fn("ClientQueries.setStorageProvider")(function* (
  userId: string,
  storageProvider: StorageProvider | null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO client_account (user_id, storage_provider)
    VALUES (${userId}, ${storageProvider})
    ON CONFLICT (user_id) DO UPDATE SET
      storage_provider = excluded.storage_provider
  `;
});

/** Removes cached account state owned by one user. */
export const clearAccount = Effect.fn("ClientQueries.clearAccount")(function* (userId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM client_account
    WHERE user_id = ${userId}
  `;
});
