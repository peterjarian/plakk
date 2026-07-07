import { and, desc, Drizzle, eq, isNull, type DrizzleService } from "@plakk/db";
import { snippets } from "@plakk/db/schema";
import type { SnippetKind } from "@plakk/shared";
import { PlakkApi, type AccountStatus } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { toApiSnippet } from "./transformers/toApiSnippet.ts";

const storageProvider = "GOOGLE_DRIVE" as const;
// ponytail: single-tenant placeholder until web auth supplies the WorkOS user id.
const ownerWorkosUserId = "dev-workos-user";
const accountStatus: AccountStatus = {
  canSync: true,
  storageProvider,
  blockedReasons: [],
};

// ponytail: DB rows are real; provider object ids stay placeholders until WorkOS Pipes upload exists.
const placeholderStorageObjectId = () => `pending-storage:${crypto.randomUUID()}`;

type CreateSnippetInput = {
  readonly id: string;
  readonly kind: Extract<SnippetKind, "TEXT" | "FILE" | "IMAGE">;
  readonly title: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly contentType: string | null;
};

const insertSnippet = Effect.fn("@plakk/web/api/PlakkApiLive.insertSnippet")(function* (
  drizzle: DrizzleService,
  input: CreateSnippetInput,
) {
  const [snippet] = yield* drizzle.db
    .insert(snippets)
    .values({
      ...input,
      ownerWorkosUserId,
      storageProvider,
      storageObjectId: placeholderStorageObjectId(),
    })
    .returning()
    .pipe(Effect.orDie);

  if (snippet === undefined) {
    return yield* Effect.die(new Error("Snippet insert returned no row"));
  }

  return toApiSnippet(snippet);
});

export const PlakkApiLive = PlakkApi.toLayer(
  PlakkApi.of({
    Ping: () =>
      Effect.succeed({ ok: true }).pipe(
        Effect.tap(() => Effect.logInfo("Ping")),
        Effect.withSpan("rpc.Ping"),
      ),
    GetAccountStatus: Effect.fn("rpc.GetAccountStatus")(function* () {
      yield* Effect.logInfo("Returning account status", { storageProvider });
      return accountStatus;
    }),
    ListSnippets: Effect.fn("rpc.ListSnippets")(function* (input) {
      return yield* Effect.gen(function* () {
        const drizzle = yield* Drizzle;

        yield* Effect.logInfo("Listing snippets", { limit: input.limit });
        const rows = yield* drizzle.db
          .select()
          .from(snippets)
          .where(and(eq(snippets.ownerWorkosUserId, ownerWorkosUserId), isNull(snippets.deletedAt)))
          .orderBy(desc(snippets.createdAt))
          .limit(input.limit)
          .pipe(Effect.orDie);

        return { items: rows.map(toApiSnippet) };
      }).pipe(Effect.annotateSpans({ limit: input.limit }));
    }),
    CreateTextSnippet: Effect.fn("rpc.CreateTextSnippet")(function* (input) {
      return yield* Effect.gen(function* () {
        const drizzle = yield* Drizzle;

        yield* Effect.logInfo("Creating text snippet", { byteSize: input.text.length });
        return yield* insertSnippet(drizzle, {
          id: input.id,
          kind: "TEXT",
          title: input.text,
          fileName: "text.txt",
          byteSize: new TextEncoder().encode(input.text).byteLength,
          contentType: "text/plain",
        });
      }).pipe(Effect.annotateSpans({ byteSize: input.text.length }));
    }),
    CreateStoredSnippet: Effect.fn("rpc.CreateStoredSnippet")(function* (input) {
      return yield* Effect.gen(function* () {
        const drizzle = yield* Drizzle;

        yield* Effect.logInfo("Creating stored snippet metadata", {
          kind: input.kind,
          byteSize: input.byteSize,
        });
        return yield* insertSnippet(drizzle, input);
      }).pipe(Effect.annotateSpans({ kind: input.kind }));
    }),
    DeleteSnippet: Effect.fn("rpc.DeleteSnippet")(function* (input) {
      return yield* Effect.gen(function* () {
        const drizzle = yield* Drizzle;

        yield* Effect.logInfo("Deleting snippet", { id: input.id });
        const now = DateTime.toDateUtc(yield* DateTime.now);
        yield* drizzle.db
          .update(snippets)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(eq(snippets.id, input.id), eq(snippets.ownerWorkosUserId, ownerWorkosUserId)))
          .pipe(Effect.orDie);
      }).pipe(Effect.annotateSpans({ id: input.id }));
    }),
  }),
);
