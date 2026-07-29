import { Effect, Layer } from "effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import { LocalStorageError } from "../models/ClientError.ts";
import Initial from "./migrations/001_initial.ts";
import Account from "./migrations/002_account.ts";

const migrate = Migrator.make({});
const loader = Migrator.fromRecord({
  "1_initial": Initial,
  "2_account": Account,
});

/**
 * Applies every pending client database migration and returns the migrations
 * that ran.
 */
export const runMigrations = Effect.fn("Client.runMigrations")(function* () {
  return yield* migrate({ loader, table: "client_runtime_migrations" }).pipe(
    Effect.catchTags({
      MigrationError: () =>
        Effect.fail(
          new LocalStorageError({
            message: "Plakk could not prepare its local data.",
          }),
        ),
      SqlError: () =>
        Effect.fail(
          new LocalStorageError({
            message: "Plakk could not prepare its local data.",
          }),
        ),
    }),
  );
});

/** Runs pending client database migrations as part of SQLite startup. */
export const clientMigrationsLayer = Layer.effectDiscard(runMigrations());
