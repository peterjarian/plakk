import { SqliteMigrator } from "@effect/sql-sqlite-wasm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export interface CounterSnapshot {
  readonly value: number;
  readonly migrationCount: number;
}

export interface CounterRepositoryShape {
  readonly increment: Effect.Effect<number, SqlError>;
  readonly read: Effect.Effect<CounterSnapshot, SqlError>;
  readonly reset: Effect.Effect<void, SqlError>;
}

export class CounterRepository extends Context.Service<CounterRepository, CounterRepositoryShape>()(
  "@plakk/sqlite-multitab-prototype/CounterRepository",
) {}

const migrationLoader = SqliteMigrator.fromRecord({
  "1_create_counter": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
      CREATE TABLE counter (
        key TEXT PRIMARY KEY NOT NULL,
        value INTEGER NOT NULL
      )
    `);
    yield* sql.unsafe("INSERT INTO counter (key, value) VALUES ('shared', 0)");
  }),
});

const runMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const migration = SqliteMigrator.run({ loader: migrationLoader }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );

  yield* Effect.tryPromise({
    try: () =>
      navigator.locks.request("plakk:sqlite-multitab-prototype:migrations", () =>
        Effect.runPromise(migration),
      ),
    catch: (cause) => cause,
  });
});

const retryOnLock = <A, R>(
  operation: Effect.Effect<A, SqlError, R>,
  remaining = 200,
): Effect.Effect<A, SqlError, R> =>
  operation.pipe(
    Effect.catchTag("SqlError", (error) => {
      const retryable =
        error.reason._tag === "LockTimeoutError" ||
        error.reason._tag === "SerializationError" ||
        String(error.reason.cause).includes("database is locked");

      if (!retryable || remaining === 0) return Effect.fail(error);
      return Effect.sleep("10 millis").pipe(
        Effect.flatMap(() => retryOnLock(operation, remaining - 1)),
      );
    }),
  );

export const CounterRepositoryLive = Layer.effect(
  CounterRepository,
  Effect.gen(function* () {
    yield* runMigrations;
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 2000");

    const increment = retryOnLock(
      sql.unsafe<{ value: number }>(`
        UPDATE counter
        SET value = value + 1
        WHERE key = 'shared'
        RETURNING value
      `),
    ).pipe(Effect.map((rows) => rows[0]?.value ?? 0));

    const read = Effect.gen(function* () {
      const values = yield* retryOnLock(
        sql.unsafe<{ value: number }>("SELECT value FROM counter WHERE key = 'shared'"),
      );
      const migrations = yield* retryOnLock(
        sql.unsafe<{ count: number }>("SELECT COUNT(*) AS count FROM effect_sql_migrations"),
      );
      return {
        value: values[0]?.value ?? 0,
        migrationCount: migrations[0]?.count ?? 0,
      };
    });

    const reset = retryOnLock(sql.unsafe("UPDATE counter SET value = 0 WHERE key = 'shared'")).pipe(
      Effect.asVoid,
    );

    return {
      increment,
      read,
      reset,
    };
  }),
);
