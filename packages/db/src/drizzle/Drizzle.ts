import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Context, type Effect } from "effect";

export type DrizzleClient =
  ReturnType<typeof PgDrizzle.makeWithDefaults> extends Effect.Effect<infer A, infer _E, infer _R>
    ? A
    : never;

export class Drizzle extends Context.Service<
  Drizzle,
  {
    readonly db: DrizzleClient;
  }
>()("@plakk/db/drizzle/Drizzle") {}

export type DrizzleService = Drizzle["Service"];
