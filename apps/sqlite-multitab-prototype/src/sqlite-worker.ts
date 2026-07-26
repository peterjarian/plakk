/// <reference lib="webworker" />

import SQLiteESMFactory from "@effect/wa-sqlite/dist/wa-sqlite.mjs";
import { OPFSCoopSyncVFS } from "@effect/wa-sqlite/src/examples/OPFSCoopSyncVFS.js";
import * as WaSqlite from "@effect/wa-sqlite";
import * as Effect from "effect/Effect";
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError";

type WorkerMessage =
  | [id: number, sql: string, params: ReadonlyArray<unknown>]
  | ["import", id: number, data: Uint8Array]
  | ["export", id: number]
  | ["update_hook"]
  | ["close"];

const workerScope = self as DedicatedWorkerGlobalScope;
const databaseName = `${workerScope.name || "shared"}.sqlite`;

const classifyError = (cause: unknown, message: string, operation: string) =>
  classifySqliteError(cause, { message, operation });

interface RetryableModule {
  readonly retryOps: Array<Promise<unknown>>;
}

const withRetryOps = async <A>(module: RetryableModule, operation: () => A) => {
  let retryCursor = module.retryOps.length;

  while (true) {
    try {
      return operation();
    } catch (cause) {
      const pending = module.retryOps.slice(retryCursor);
      retryCursor = module.retryOps.length;
      if (pending.length === 0) throw cause;
      await Promise.all(pending);
    }
  }
};

const run = Effect.gen(function* () {
  const factory = yield* Effect.promise(() => SQLiteESMFactory());
  const sqlite3 = WaSqlite.Factory(factory);
  const vfs = yield* Effect.promise(() => OPFSCoopSyncVFS.create("opfs-coop", factory));
  sqlite3.vfs_register(vfs, false);

  const db = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        withRetryOps(factory as RetryableModule, () =>
          sqlite3.open_v2(databaseName, undefined, "opfs-coop"),
        ),
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "openDatabase"),
        }),
    }),
    (handle) => Effect.sync(() => sqlite3.close(handle)),
  );

  return yield* Effect.callback<void>((resume) => {
    const onMessage = async (event: MessageEvent<WorkerMessage>) => {
      let messageId = -1;

      try {
        const message = event.data;
        switch (message[0]) {
          case "close": {
            workerScope.close();
            resume(Effect.void);
            return;
          }
          case "import": {
            const [, id, data] = message;
            messageId = id;
            sqlite3.deserialize(db, "main", data, data.length, data.length, 1 | 2);
            workerScope.postMessage([id, undefined, undefined]);
            return;
          }
          case "export": {
            const [, id] = message;
            messageId = id;
            const data = sqlite3.serialize(db, "main");
            workerScope.postMessage([id, undefined, data], [data.buffer]);
            return;
          }
          case "update_hook": {
            sqlite3.update_hook(db, (_operation, _database, table, rowId) => {
              if (!table) return;
              workerScope.postMessage(["update_hook", table, Number(rowId)]);
            });
            return;
          }
          default: {
            const [id, sql, params] = message;
            messageId = id;
            const [columns, rows] = await withRetryOps(factory as RetryableModule, () => {
              const rows: Array<Array<unknown>> = [];
              let columns: Array<string> | undefined;

              for (const statement of sqlite3.statements(db, sql)) {
                sqlite3.bind_collection(statement, params as Array<SQLiteCompatibleType>);
                while (sqlite3.step(statement) === WaSqlite.SQLITE_ROW) {
                  columns ??= sqlite3.column_names(statement);
                  rows.push(sqlite3.row(statement));
                }
              }

              return [columns, rows] as const;
            });

            workerScope.postMessage([id, undefined, [columns, rows]]);
          }
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        workerScope.postMessage([messageId, message, undefined]);
      }
    };

    workerScope.addEventListener("message", onMessage);
    workerScope.postMessage(["ready", undefined, undefined]);

    return Effect.sync(() => workerScope.removeEventListener("message", onMessage));
  });
}).pipe(Effect.scoped);

Effect.runPromise(run).catch((cause) => {
  const diagnostic = {
    constructor: cause?.constructor?.name,
    message: cause instanceof Error ? cause.message : String(cause),
    ownProperties:
      typeof cause === "object" && cause !== null
        ? Object.fromEntries(
            Object.getOwnPropertyNames(cause).map((name) => [
              name,
              String((cause as Record<string, unknown>)[name]),
            ]),
          )
        : {},
    stack: cause instanceof Error ? cause.stack : undefined,
  };
  console.error(`SQLite worker failed: ${JSON.stringify(diagnostic)}`);
  throw new Error(`SQLite worker failed: ${JSON.stringify(diagnostic)}`);
});
