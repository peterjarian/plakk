import { sql, type DrizzleService } from "@plakk/db";
import * as Effect from "effect/Effect";

export const SNIPPET_INVALIDATION_CHANNEL = "plakk_snippet_invalidations";

export const notifySnippetChanges = Effect.fn("notifySnippetChanges")(function* (
  db: Pick<DrizzleService["db"], "execute">,
  ownerWorkosUserId: string,
) {
  yield* db.execute(sql`select pg_notify(${SNIPPET_INVALIDATION_CHANNEL}, ${ownerWorkosUserId})`);
});
