import { Effect, Layer } from "effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import { LocalStorageError } from "../models/ClientError.ts";
import Initial from "./migrations/001_initial.ts";

const migrate = Migrator.make({});
const loader = Migrator.fromRecord({
  "1_initial": Initial,
});

/**
 * Applies every pending client database migration and returns the migrations
 * that ran.
 */
export const runMigrations = Effect.fn("ClientRuntime.runMigrations")(function* () {
  return yield* migrate({ loader }).pipe(
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
