import { and, desc, eq, isNull } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { Database } from "./Database.ts";
import { snippets } from "./schema.ts";

export type DbSnippet = typeof snippets.$inferSelect;

export const listSnippets = Effect.fn("@plakk/db/Snippets.listSnippets")(function* (input: {
  readonly ownerWorkosUserId: string;
  readonly limit: number;
}) {
  const { db } = yield* Database;

  return yield* db
    .select()
    .from(snippets)
    .where(and(eq(snippets.ownerWorkosUserId, input.ownerWorkosUserId), isNull(snippets.deletedAt)))
    .orderBy(desc(snippets.createdAt))
    .limit(input.limit);
});

export const insertSnippet = Effect.fn("@plakk/db/Snippets.insertSnippet")(function* (input: {
  readonly ownerWorkosUserId: string;
  readonly kind: "TEXT" | "FILE" | "IMAGE";
  readonly title: string;
  readonly storageProvider: "GOOGLE_DRIVE" | "ONE_DRIVE" | "DROPBOX";
  readonly storageObjectId: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly contentType: string | null;
}) {
  const { db } = yield* Database;
  const [snippet] = yield* db.insert(snippets).values(input).returning();

  if (snippet === undefined) {
    return yield* Effect.die(new Error("Snippet insert returned no row"));
  }

  return snippet;
});

export const deleteSnippet = Effect.fn("@plakk/db/Snippets.deleteSnippet")(function* (input: {
  readonly ownerWorkosUserId: string;
  readonly id: string;
}) {
  const { db } = yield* Database;
  const now = DateTime.toDateUtc(yield* DateTime.now);

  yield* db
    .update(snippets)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(snippets.id, input.id), eq(snippets.ownerWorkosUserId, input.ownerWorkosUserId)));
});
