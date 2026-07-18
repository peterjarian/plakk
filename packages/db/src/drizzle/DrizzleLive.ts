import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Config, Effect, Layer } from "effect";
import { types } from "pg";
import { Drizzle } from "./Drizzle.ts";

const rawDateTimeTypeIds = new Set([1082, 1114, 1115, 1182, 1184, 1185, 1186, 1187, 1231]);
// Drizzle handles these PG date/time values; keep pg from eagerly parsing them.
const preserveRawPgValue = (value: string) => value;

export const PgClientLive = Layer.unwrap(
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

export const DrizzleLive = Layer.effect(
  Drizzle,
  Effect.gen(function* () {
    const db = yield* makeDatabase();
    return Drizzle.of({ db });
  }),
).pipe(Layer.provide(PgClientLive));
