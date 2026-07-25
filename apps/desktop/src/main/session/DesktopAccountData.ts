import type { Effect } from "effect";
import { Context, Schema } from "effect";

export class DesktopAccountPurgeError extends Schema.TaggedErrorClass<DesktopAccountPurgeError>()(
  "DesktopAccountPurgeError",
  { failures: Schema.Array(Schema.Struct({ owner: Schema.String, cause: Schema.Defect() })) },
) {}

export interface DesktopAccountDataShape {
  readonly purge: (accountId: string) => Effect.Effect<void, DesktopAccountPurgeError>;
}

export class DesktopAccountData extends Context.Service<
  DesktopAccountData,
  DesktopAccountDataShape
>()("plakk/main/session/DesktopAccountData") {}
