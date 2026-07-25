import { SqliteClient } from "@effect/sql-sqlite-node";
import { basename } from "node:path";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runDesktopMigrations } from "./Migrations.ts";

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`PRAGMA busy_timeout = 5000`;
    yield* runDesktopMigrations;
  }),
);

export const makeDesktopSqliteLayer = (filename: string) => {
  const client = SqliteClient.layer({
    filename,
    spanAttributes: {
      "db.name": basename(filename),
      "service.name": "plakk-desktop",
    },
  });
  return setup.pipe(Layer.provideMerge(client));
};
