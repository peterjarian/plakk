import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-wasm";
import { AccountStatusSchema, ApiSnippetSchema } from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import type { AccountProductSnapshot } from "./product-reader.ts";
import {
  AccountProductMirror,
  AccountProductMirrorError,
  makeRuntimeFallbackAccountProductMirror,
  makeSessionMemoryAccountProductMirrorLayer,
} from "./readable-mirror.ts";

const LOCK_RETRY_DELAY = "10 millis";
const MAX_LOCK_RETRIES = 200;
const MIGRATION_LOCK_TIMEOUT_MILLIS = 10_000;

const StoredSnapshotCodec = Schema.fromJsonString(
  Schema.Struct({
    account: AccountStatusSchema,
    snippets: Schema.Array(ApiSnippetSchema),
  }),
);

const StoredSnapshotRow = Schema.Struct({
  snapshotJson: Schema.String,
});

const migrationLoader = SqliteMigrator.fromRecord({
  "1_create_readable_mirror": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
      CREATE TABLE readable_mirror (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        snapshot_json TEXT NOT NULL
      )
    `);
  }),
});

const describeErrorValue = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value instanceof Error
      ? `${value.name}: ${value.message}`
      : "";

const errorDescriptions = (error: unknown): ReadonlyArray<string> => {
  if (typeof error !== "object" || error === null) return [describeErrorValue(error)];
  const record = error as Readonly<Record<string, unknown>>;
  const reason =
    typeof record.reason === "object" && record.reason !== null
      ? (record.reason as Readonly<Record<string, unknown>>)
      : null;
  return [
    describeErrorValue(error),
    describeErrorValue(record.cause),
    describeErrorValue(reason?.cause),
    describeErrorValue(reason?._tag),
  ];
};

const isTransientLock = (error: unknown): boolean =>
  errorDescriptions(error).some(
    (description) =>
      description.includes("database is locked") ||
      description.includes("LockTimeoutError") ||
      description.includes("SerializationError"),
  );

const retryTransientLock = Effect.fn("WebReadableMirror.retryTransientLock")(function* <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  remaining = MAX_LOCK_RETRIES,
): Effect.fn.Return<A, E, R> {
  return yield* operation.pipe(
    Effect.catch((error) =>
      remaining > 0 && isTransientLock(error)
        ? Effect.sleep(LOCK_RETRY_DELAY).pipe(
            Effect.andThen(retryTransientLock(operation, remaining - 1)),
          )
        : Effect.fail(error),
    ),
  );
});

const mapMirrorError = (reason: string) => (cause: unknown) =>
  new AccountProductMirrorError({ cause, reason });

const withMigrationLock = Effect.fn("WebReadableMirror.withMigrationLock")(function* <A, E>(
  lockName: string,
  migration: Effect.Effect<A, E>,
): Effect.fn.Return<A, AccountProductMirrorError> {
  return yield* Effect.tryPromise({
    try: (signal) =>
      navigator.locks.request(lockName, { signal }, () =>
        Effect.runPromise(retryTransientLock(migration)),
      ),
    catch: mapMirrorError("Could not serialize readable mirror migrations."),
  }).pipe(
    Effect.timeout(`${MIGRATION_LOCK_TIMEOUT_MILLIS} millis`),
    Effect.mapError(mapMirrorError("Could not serialize readable mirror migrations.")),
  );
});

const makeSqlAccountProductMirrorLayer = (
  channelName: string,
  migrationLockName: string,
): Layer.Layer<AccountProductMirror, AccountProductMirrorError, SqlClient.SqlClient> =>
  Layer.effect(
    AccountProductMirror,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migration = SqliteMigrator.run({ loader: migrationLoader }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      yield* withMigrationLock(migrationLockName, migration);
      yield* retryTransientLock(sql.unsafe("PRAGMA busy_timeout = 2000")).pipe(
        Effect.mapError(mapMirrorError("Could not configure the readable mirror.")),
      );

      const notifications = yield* PubSub.unbounded<void>();
      const channel = yield* Effect.acquireRelease(
        Effect.sync(() => new BroadcastChannel(channelName)),
        (activeChannel) => Effect.sync(() => activeChannel.close()),
      );
      const onMessage = () => {
        PubSub.publishUnsafe(notifications, undefined);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => channel.addEventListener("message", onMessage)),
        () => Effect.sync(() => channel.removeEventListener("message", onMessage)),
      );

      const readRows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: StoredSnapshotRow,
        execute: () =>
          sql`
          SELECT snapshot_json AS "snapshotJson"
          FROM readable_mirror
          WHERE singleton = 1
        `,
      });

      const purgeSql = retryTransientLock(
        sql`
          DELETE FROM readable_mirror
          WHERE singleton = 1
        `,
      ).pipe(
        Effect.mapError(mapMirrorError("Could not purge the readable mirror.")),
        Effect.asVoid,
      );

      const read = retryTransientLock(readRows(undefined)).pipe(
        Effect.mapError(mapMirrorError("Could not read the readable mirror.")),
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (row === undefined) return Effect.succeed(null);
          return Schema.decodeEffect(StoredSnapshotCodec)(row.snapshotJson).pipe(
            Effect.catch(() => purgeSql.pipe(Effect.as(null))),
            Effect.map((snapshot) => snapshot satisfies AccountProductSnapshot | null),
          );
        }),
      );

      const replace = Effect.fn("WebReadableMirror.replace")(function* (
        snapshot: AccountProductSnapshot,
      ) {
        const snapshotJson = yield* Schema.encodeEffect(StoredSnapshotCodec)(snapshot).pipe(
          Effect.mapError(mapMirrorError("Could not encode the readable mirror.")),
        );
        yield* retryTransientLock(
          sql`
            INSERT INTO readable_mirror (singleton, snapshot_json)
            VALUES (1, ${snapshotJson})
            ON CONFLICT (singleton) DO UPDATE
            SET snapshot_json = excluded.snapshot_json
          `,
        ).pipe(Effect.mapError(mapMirrorError("Could not replace the readable mirror.")));
        yield* Effect.sync(() => channel.postMessage(undefined));
      });

      return makeRuntimeFallbackAccountProductMirror(
        AccountProductMirror.of({
          changes: Stream.fromPubSub(notifications),
          purge: purgeSql.pipe(Effect.tap(() => Effect.sync(() => channel.postMessage(undefined)))),
          read,
          readPerformance: "accelerated",
          replace,
        }),
      );
    }),
  );

type BrowserCapabilities = {
  readonly BroadcastChannel?: unknown;
  readonly Worker?: unknown;
  readonly navigator?: {
    readonly locks?: { readonly request?: unknown };
    readonly storage?: { readonly getDirectory?: unknown };
  };
};

export const supportsDurableReadableMirror = (browser: BrowserCapabilities = globalThis): boolean =>
  typeof browser.Worker === "function" &&
  typeof browser.BroadcastChannel === "function" &&
  typeof browser.navigator?.locks?.request === "function" &&
  typeof browser.navigator?.storage?.getDirectory === "function";

export const makeBrowserAccountProductMirrorLayer = (
  accountId: string,
  options?: {
    readonly forceSessionMemory?: boolean;
    readonly installTestWriteDelay?: (setDelay: (milliseconds: number) => void) => void;
    readonly onTestWriteStarted?: () => void;
  },
): Layer.Layer<AccountProductMirror> => {
  if (options?.forceSessionMemory === true || !supportsDurableReadableMirror()) {
    return makeSessionMemoryAccountProductMirrorLayer();
  }

  const databaseId = `plakk-readable-mirror-${encodeURIComponent(accountId)}`;
  const sqliteLayer = SqliteClient.layer({
    worker: Effect.acquireRelease(
      Effect.sync(() => {
        const worker = new Worker(new URL("./readable-mirror-worker.ts", import.meta.url), {
          name: databaseId,
          type: "module",
        });
        if (options?.onTestWriteStarted !== undefined) {
          worker.addEventListener("message", (event) => {
            if (event.data?.[0] === "plakk_test_write_started") {
              options.onTestWriteStarted?.();
            }
          });
        }
        options?.installTestWriteDelay?.((milliseconds) => {
          worker.postMessage(["plakk_test_write_delay", milliseconds]);
        });
        return worker;
      }),
      (worker) => Effect.sync(() => worker.terminate()),
    ),
  });

  return makeSqlAccountProductMirrorLayer(`${databaseId}:changes`, `${databaseId}:migrations`).pipe(
    Layer.provide(sqliteLayer),
    Layer.catch(() => makeSessionMemoryAccountProductMirrorLayer()),
  );
};
