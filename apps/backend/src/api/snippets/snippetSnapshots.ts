import { desc, eq, type DrizzleService } from "@plakk/db";
import { snippets } from "@plakk/db/schema";
import * as Effect from "effect/Effect";

import { toApiSnippet } from "../transformers/toApiSnippet.ts";

export const getSnippetSnapshot = Effect.fn("getSnippetSnapshot")(function* (
  drizzle: DrizzleService,
  ownerWorkosUserId: string,
) {
  const rows = yield* drizzle.db
    .select()
    .from(snippets)
    .where(eq(snippets.ownerWorkosUserId, ownerWorkosUserId))
    .orderBy(desc(snippets.createdAt))
    .pipe(Effect.orDie);

  yield* Effect.annotateCurrentSpan({ itemCount: rows.length });
  yield* Effect.logInfo("Read complete Snippet snapshot", { itemCount: rows.length });
  return rows.map(toApiSnippet);
});
