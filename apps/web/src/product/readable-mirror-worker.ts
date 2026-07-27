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
  | ["plakk_test_write_delay", milliseconds: number]
  | ["close"];

interface RetryableModule {
  readonly retryOps: Array<Promise<unknown>>;
}

const workerScope = self as DedicatedWorkerGlobalScope;
const databaseName = `${workerScope.name || "plakk-readable-mirror"}.sqlite`;

const withOwnershipHandoff = async <A>(module: RetryableModule, operation: () => A) => {
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
  const vfs = yield* Effect.promise(() => OPFSCoopSyncVFS.create("plakk-opfs-coop", factory));
  sqlite3.vfs_register(vfs as Parameters<typeof sqlite3.vfs_register>[0], false);

  const database = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        withOwnershipHandoff(factory as RetryableModule, () =>
          sqlite3.open_v2(databaseName, undefined, "plakk-opfs-coop"),
        ),
      catch: (cause) =>
        new SqlError({
          reason: classifySqliteError(cause, {
            message: "Failed to open readable mirror",
            operation: "openDatabase",
          }),
        }),
    }),
    (handle) => Effect.sync(() => sqlite3.close(handle)),
  );

  return yield* Effect.callback<void>((resume) => {
    let testWriteDelayMillis = 0;
    const onMessage = async (event: MessageEvent<WorkerMessage>) => {
      let messageId = -1;
      let testTransactionStarted = false;
      try {
        const message = event.data;
        if (import.meta.env.DEV && message[0] === "plakk_test_write_delay") {
          testWriteDelayMillis = message[1];
          return;
        }
        switch (message[0]) {
          case "close": {
            resume(Effect.void);
            return;
          }
          case "import": {
            const [, id, data] = message;
            messageId = id;
            sqlite3.deserialize(database, "main", data, data.length, data.length, 1 | 2);
            workerScope.postMessage([id, undefined, undefined]);
            return;
          }
          case "export": {
            const [, id] = message;
            messageId = id;
            const data = sqlite3.serialize(database, "main");
            workerScope.postMessage([id, undefined, data], [data.buffer]);
            return;
          }
          case "update_hook": {
            sqlite3.update_hook(database, (_operation, _database, table, rowId) => {
              if (!table) return;
              workerScope.postMessage(["update_hook", table, Number(rowId)]);
            });
            return;
          }
          default: {
            const [id, sql, params] = message as [
              id: number,
              sql: string,
              params: ReadonlyArray<unknown>,
            ];
            messageId = id;
            const isTestDelayedWrite =
              testWriteDelayMillis > 0 && sql.includes("INSERT INTO readable_mirror");
            if (isTestDelayedWrite) {
              await withOwnershipHandoff(factory as RetryableModule, () => {
                for (const statement of sqlite3.statements(database, "BEGIN IMMEDIATE")) {
                  sqlite3.step(statement);
                }
              });
              testTransactionStarted = true;
              if (import.meta.env.DEV) {
                workerScope.postMessage(["plakk_test_write_started", undefined, undefined]);
              }
              await Effect.runPromise(Effect.sleep(`${testWriteDelayMillis} millis`));
            }
            const [columns, rows] = await withOwnershipHandoff(factory as RetryableModule, () => {
              const rows: Array<Array<unknown>> = [];
              let columns: Array<string> | undefined;
              for (const statement of sqlite3.statements(database, sql)) {
                sqlite3.bind_collection(statement, params as Array<SQLiteCompatibleType>);
                while (sqlite3.step(statement) === WaSqlite.SQLITE_ROW) {
                  columns ??= sqlite3.column_names(statement);
                  rows.push(sqlite3.row(statement));
                }
              }
              return [columns, rows] as const;
            });
            if (isTestDelayedWrite) {
              await withOwnershipHandoff(factory as RetryableModule, () => {
                for (const statement of sqlite3.statements(database, "COMMIT")) {
                  sqlite3.step(statement);
                }
              });
              testTransactionStarted = false;
            }
            workerScope.postMessage([id, undefined, [columns, rows]]);
          }
        }
      } catch (cause) {
        if (testTransactionStarted) {
          try {
            for (const statement of sqlite3.statements(database, "ROLLBACK")) {
              sqlite3.step(statement);
            }
          } catch {
            // The original statement failure is the useful protocol error.
          }
        }
        workerScope.postMessage([
          messageId,
          cause instanceof Error ? cause.message : String(cause),
          undefined,
        ]);
      }
    };

    workerScope.addEventListener("message", onMessage);
    workerScope.postMessage(["ready", undefined, undefined]);
    return Effect.sync(() => workerScope.removeEventListener("message", onMessage));
  });
}).pipe(Effect.scoped);

const activateUnavailableProtocol = () => {
  const onMessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (message[0] === "close") {
      workerScope.close();
      return;
    }
    const messageId = typeof message[0] === "number" ? message[0] : message[1];
    if (typeof messageId === "number") {
      workerScope.postMessage([messageId, "Readable mirror is unavailable.", undefined]);
    }
  };
  workerScope.addEventListener("message", onMessage);
  workerScope.postMessage(["ready", undefined, undefined]);
};

void Effect.runPromise(
  run.pipe(Effect.tapCause((cause) => Effect.logError("Readable mirror worker failed", cause))),
).then(
  () => workerScope.close(),
  () => activateUnavailableProtocol(),
);
