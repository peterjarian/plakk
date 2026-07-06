import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Config, Context, Effect, Layer } from "effect";
import type * as EffectContext from "effect/Context";
import { types } from "pg";

const rawDateTimeTypeIds = new Set([1082, 1114, 1115, 1182, 1184, 1185, 1186, 1187, 1231]);
// Drizzle handles these PG date/time values; keep pg from eagerly parsing them.
const preserveRawPgValue = (value: string) => value;

const PgClientLive = Layer.unwrap(
  Config.redacted("DATABASE_URL").pipe(
    Effect.map((url) =>
      PgClient.layer({
        url,
        types: {
          getTypeParser: (typeId, format) =>
            rawDateTimeTypeIds.has(typeId)
              ? preserveRawPgValue
              : types.getTypeParser(typeId, format),
        },
      }),
    ),
  ),
);

const makeDatabase = () => PgDrizzle.makeWithDefaults();

type DatabaseClient =
  ReturnType<typeof makeDatabase> extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;

export class Database extends Context.Service<
  Database,
  {
    readonly db: DatabaseClient;
  }
>()("@plakk/db/Database") {
  static readonly Live = Layer.effect(
    Database,
    Effect.gen(function* () {
      const db = yield* makeDatabase();
      return Database.of({ db });
    }),
  ).pipe(Layer.provide(PgClientLive));
}

export type DatabaseService = EffectContext.Service.Shape<typeof Database>;
