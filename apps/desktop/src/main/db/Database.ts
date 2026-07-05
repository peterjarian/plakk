import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Config, Context, Effect, Layer } from "effect";
import { types } from "pg";

const dateTimeTypeIds = new Set([1082, 1114, 1115, 1182, 1184, 1185, 1186, 1187, 1231]);
const parseDateTime = (value: string) => value;

const PgClientLive = Layer.unwrap(
  Config.redacted("DATABASE_URL").pipe(
    Effect.map((url) =>
      PgClient.layer({
        url,
        types: {
          getTypeParser: (typeId, format) =>
            dateTimeTypeIds.has(typeId) ? parseDateTime : types.getTypeParser(typeId, format),
        },
      }),
    ),
  ),
);

const makeDatabase = () => PgDrizzle.makeWithDefaults();

type DatabaseClient =
  ReturnType<typeof makeDatabase> extends Effect.Effect<infer A, never, infer _R> ? A : never;

export class Database extends Context.Service<
  Database,
  {
    readonly db: DatabaseClient;
  }
>()("plakk/main/db/Database") {
  static readonly Live = Layer.effect(
    Database,
    Effect.gen(function* () {
      const db = yield* makeDatabase();
      return Database.of({ db });
    }),
  ).pipe(Layer.provide(PgClientLive));
}
