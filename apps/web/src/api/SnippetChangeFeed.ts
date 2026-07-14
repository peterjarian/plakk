import { and, asc, desc, eq, gt, isNull, lte, sql, type DrizzleService } from "@plakk/db";
import {
  snippetChangeFeeds,
  snippetChanges,
  snippets,
  type SnippetChangeRow,
  type SnippetRow,
} from "@plakk/db/schema";
import {
  ApiSnippetSchema,
  type ApiSnippetChange,
  type SnippetChangePage,
} from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { toApiSnippet } from "./transformers/toApiSnippet.ts";

const RETAINED_CHANGES_PER_ACCOUNT = 10_000n;
const CursorPayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  ownerWorkosUserId: Schema.String,
  sequence: Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)$/)),
});
const decodeCursorPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(CursorPayloadSchema));

type ChangeDatabase = Pick<DrizzleService["db"], "delete" | "insert">;
type StoredChange = Pick<
  SnippetChangeRow,
  "changeType" | "ownerWorkosUserId" | "sequence" | "snapshot" | "snippetId"
>;

export const encodeSnippetChangeCursor = (ownerWorkosUserId: string, sequence: bigint): string =>
  Buffer.from(
    JSON.stringify({ version: 1, ownerWorkosUserId, sequence: sequence.toString() }),
  ).toString("base64url");

const decodeSnippetChangeCursor = Effect.fn("decodeSnippetChangeCursor")(function* (
  cursor: string,
) {
  const payload = yield* decodeCursorPayload(Buffer.from(cursor, "base64url").toString("utf8"));
  return { ownerWorkosUserId: payload.ownerWorkosUserId, sequence: BigInt(payload.sequence) };
});

const decodeAccountCursor = Effect.fn("decodeAccountCursor")(function* (
  cursor: string,
  ownerWorkosUserId: string,
) {
  const decoded = yield* decodeSnippetChangeCursor(cursor).pipe(Effect.option);
  return Option.filter(decoded, (value) => value.ownerWorkosUserId === ownerWorkosUserId);
});

const changeFromRow = Effect.fn("changeFromRow")(function* (
  row: StoredChange,
): Effect.fn.Return<ApiSnippetChange> {
  if (row.changeType === "DELETE") {
    return { type: "DELETE", snippetId: row.snippetId };
  }

  return {
    type: "UPSERT",
    snippet: yield* Schema.decodeUnknownEffect(ApiSnippetSchema)(row.snapshot).pipe(Effect.orDie),
  };
});

const makePage = Effect.fn("makePage")(function* (input: {
  readonly ownerWorkosUserId: string;
  readonly sequence: bigint;
  readonly latestSequence: bigint;
  readonly firstRetainedSequence: bigint | null;
  readonly changes: ReadonlyArray<StoredChange>;
}): Effect.fn.Return<SnippetChangePage> {
  if (
    input.sequence > input.latestSequence ||
    (input.firstRetainedSequence === null
      ? input.sequence < input.latestSequence
      : input.sequence + 1n < input.firstRetainedSequence)
  ) {
    return { status: "RESNAPSHOT_REQUIRED" };
  }

  const rows = input.changes.filter(
    (change) => change.ownerWorkosUserId === input.ownerWorkosUserId,
  );
  return {
    status: "OK",
    changes: yield* Effect.forEach(rows, changeFromRow),
    nextCursor: encodeSnippetChangeCursor(
      input.ownerWorkosUserId,
      rows.at(-1)?.sequence ?? input.sequence,
    ),
  };
});

export const makeSnippetChangePage = Effect.fn("makeSnippetChangePage")(function* (input: {
  readonly ownerWorkosUserId: string;
  readonly cursor: string;
  readonly latestSequence: bigint;
  readonly firstRetainedSequence: bigint | null;
  readonly changes: ReadonlyArray<StoredChange>;
}): Effect.fn.Return<SnippetChangePage> {
  const decoded = yield* decodeAccountCursor(input.cursor, input.ownerWorkosUserId);
  if (Option.isNone(decoded)) {
    return { status: "RESNAPSHOT_REQUIRED" };
  }
  return yield* makePage({ ...input, sequence: decoded.value.sequence });
});

export const appendSnippetChange = Effect.fn("appendSnippetChange")(function* (
  db: ChangeDatabase,
  change:
    | { readonly type: "UPSERT"; readonly snippet: SnippetRow }
    | {
        readonly type: "DELETE";
        readonly ownerWorkosUserId: string;
        readonly snippetId: string;
      },
) {
  const ownerWorkosUserId =
    change.type === "UPSERT" ? change.snippet.ownerWorkosUserId : change.ownerWorkosUserId;
  const snippetId = change.type === "UPSERT" ? change.snippet.id : change.snippetId;
  const [feed] = yield* db
    .insert(snippetChangeFeeds)
    .values({ ownerWorkosUserId, latestSequence: 1n })
    .onConflictDoUpdate({
      target: snippetChangeFeeds.ownerWorkosUserId,
      set: { latestSequence: sql`${snippetChangeFeeds.latestSequence} + 1` },
    })
    .returning({ latestSequence: snippetChangeFeeds.latestSequence });

  if (feed === undefined) {
    return yield* Effect.die(new Error("Snippet change sequence update returned no row"));
  }

  yield* db.insert(snippetChanges).values({
    ownerWorkosUserId,
    sequence: feed.latestSequence,
    changeType: change.type,
    snippetId,
    snapshot: change.type === "UPSERT" ? toApiSnippet(change.snippet) : null,
  });

  if (feed.latestSequence > RETAINED_CHANGES_PER_ACCOUNT) {
    yield* db
      .delete(snippetChanges)
      .where(
        and(
          eq(snippetChanges.ownerWorkosUserId, ownerWorkosUserId),
          lte(snippetChanges.sequence, feed.latestSequence - RETAINED_CHANGES_PER_ACCOUNT),
        ),
      );
  }
});

export const getSnippetSnapshot = Effect.fn("getSnippetSnapshot")(function* (
  drizzle: DrizzleService,
  ownerWorkosUserId: string,
) {
  return yield* drizzle.db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .insert(snippetChangeFeeds)
          .values({ ownerWorkosUserId, latestSequence: 0n })
          .onConflictDoNothing();
        const [feed] = yield* tx
          .select()
          .from(snippetChangeFeeds)
          .where(eq(snippetChangeFeeds.ownerWorkosUserId, ownerWorkosUserId))
          .for("update");
        if (feed === undefined) {
          return yield* Effect.die(new Error("Snippet change feed row was not found"));
        }
        const rows = yield* tx
          .select()
          .from(snippets)
          .where(and(eq(snippets.ownerWorkosUserId, ownerWorkosUserId), isNull(snippets.deletedAt)))
          .orderBy(
            desc(sql<boolean>`${snippets.kind} = 'TEXT' and ${snippets.storageProvider} is null`),
            desc(snippets.createdAt),
          );
        return {
          rows,
          cursor: encodeSnippetChangeCursor(ownerWorkosUserId, feed.latestSequence),
        };
      }),
    )
    .pipe(Effect.orDie);
});

export const pullSnippetChanges = Effect.fn("pullSnippetChanges")(function* (
  drizzle: DrizzleService,
  ownerWorkosUserId: string,
  cursor: string,
  limit: number,
): Effect.fn.Return<SnippetChangePage> {
  const decoded = yield* decodeAccountCursor(cursor, ownerWorkosUserId);
  if (Option.isNone(decoded)) {
    return { status: "RESNAPSHOT_REQUIRED" };
  }

  const data = yield* drizzle.db
    .transaction((tx) =>
      Effect.gen(function* () {
        const [feed] = yield* tx
          .select()
          .from(snippetChangeFeeds)
          .where(eq(snippetChangeFeeds.ownerWorkosUserId, ownerWorkosUserId));
        const latestSequence = feed?.latestSequence ?? 0n;
        const [firstRetained] = yield* tx
          .select({ sequence: snippetChanges.sequence })
          .from(snippetChanges)
          .where(eq(snippetChanges.ownerWorkosUserId, ownerWorkosUserId))
          .orderBy(asc(snippetChanges.sequence))
          .limit(1);
        const changes = yield* tx
          .select()
          .from(snippetChanges)
          .where(
            and(
              eq(snippetChanges.ownerWorkosUserId, ownerWorkosUserId),
              gt(snippetChanges.sequence, decoded.value.sequence),
            ),
          )
          .orderBy(asc(snippetChanges.sequence))
          .limit(limit);
        return {
          latestSequence,
          firstRetainedSequence: firstRetained?.sequence ?? null,
          changes,
        };
      }),
    )
    .pipe(Effect.orDie);

  return yield* makePage({
    ownerWorkosUserId,
    sequence: decoded.value.sequence,
    ...data,
  });
});
