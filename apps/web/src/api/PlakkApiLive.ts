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

type ListSnippetsInput = {
  readonly limit: number;
};

type CreateSnippetInput = {
  readonly kind: Extract<SnippetKind, "TEXT" | "FILE" | "IMAGE">;
  readonly title: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly contentType: string | null;
};

type CreateStoredSnippetInput = Omit<CreateSnippetInput, "kind"> & {
  readonly kind: Extract<SnippetKind, "FILE" | "IMAGE">;
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

const getAccountStatus = Effect.fn("@plakk/web/api/PlakkApiLive.getAccountStatus")(function* () {
  yield* Effect.logInfo("Returning account status", { storageProvider });
  return accountStatus;
});

const listSnippets = Effect.fn("@plakk/web/api/PlakkApiLive.listSnippets")(function* (
  input: ListSnippetsInput,
) {
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
});

const createTextSnippet = Effect.fn("@plakk/web/api/PlakkApiLive.createTextSnippet")(function* (
  text: string,
) {
  const drizzle = yield* Drizzle;

  yield* Effect.logInfo("Creating text snippet", { byteSize: text.length });
  return yield* insertSnippet(drizzle, {
    kind: "TEXT",
    title: text,
    fileName: "text.txt",
    byteSize: new TextEncoder().encode(text).byteLength,
    contentType: "text/plain",
  });
});

const createStoredSnippet = Effect.fn("@plakk/web/api/PlakkApiLive.createStoredSnippet")(function* (
  input: CreateStoredSnippetInput,
) {
  const drizzle = yield* Drizzle;

  yield* Effect.logInfo("Creating stored snippet metadata", {
    kind: input.kind,
    byteSize: input.byteSize,
  });
  return yield* insertSnippet(drizzle, input);
});

const deleteSnippet = Effect.fn("@plakk/web/api/PlakkApiLive.deleteSnippet")(function* (
  id: string,
) {
  const drizzle = yield* Drizzle;

  yield* Effect.logInfo("Deleting snippet", { id });
  const now = DateTime.toDateUtc(yield* DateTime.now);
  yield* drizzle.db
    .update(snippets)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(snippets.id, id), eq(snippets.ownerWorkosUserId, ownerWorkosUserId)))
    .pipe(Effect.orDie);
});

export const PlakkApiLive = PlakkApi.toLayer(
  PlakkApi.of({
    Ping: () =>
      Effect.succeed({ ok: true }).pipe(
        Effect.tap(() => Effect.logInfo("Ping")),
        Effect.withSpan("rpc.Ping"),
      ),
    GetAccountStatus: () => getAccountStatus().pipe(Effect.withSpan("rpc.GetAccountStatus")),
    ListSnippets: (input) =>
      listSnippets(input).pipe(
        Effect.withSpan("rpc.ListSnippets", {
          attributes: { limit: input.limit },
        }),
      ),
    CreateTextSnippet: (input) =>
      createTextSnippet(input.text).pipe(
        Effect.withSpan("rpc.CreateTextSnippet", { attributes: { byteSize: input.text.length } }),
      ),
    CreateStoredSnippet: (input) =>
      createStoredSnippet(input).pipe(
        Effect.withSpan("rpc.CreateStoredSnippet", {
          attributes: { kind: input.kind },
        }),
      ),
    DeleteSnippet: (input) =>
      deleteSnippet(input.id).pipe(
        Effect.withSpan("rpc.DeleteSnippet", { attributes: { id: input.id } }),
      ),
  }),
);
