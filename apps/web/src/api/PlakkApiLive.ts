import { and, desc, Drizzle, eq, isNull, type DrizzleService } from "@plakk/db";
import { snippets } from "@plakk/db/schema";
import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const storageProvider = "GOOGLE_DRIVE" as const;
// ponytail: single-tenant placeholder until web auth supplies the WorkOS user id.
const ownerWorkosUserId = "dev-workos-user";
const accountStatus: AccountStatus = {
  canSync: true,
  storageProvider,
  blockedReasons: [],
};

const toApiSnippet = (snippet: typeof snippets.$inferSelect): ApiSnippet => ({
  id: snippet.id,
  kind: snippet.kind,
  title: snippet.title,
  fileName: snippet.fileName,
  byteSize: snippet.byteSize,
  contentType: snippet.contentType,
  storageProvider: snippet.storageProvider,
  createdAt: snippet.createdAt.toISOString(),
  updatedAt: snippet.updatedAt.toISOString(),
});

// ponytail: DB rows are real; provider object ids stay placeholders until WorkOS Pipes upload exists.
const placeholderStorageObjectId = () => `pending-storage:${crypto.randomUUID()}`;

const insertSnippet = Effect.fn("@plakk/web/api/PlakkApiLive.insertSnippet")(function* (
  drizzle: DrizzleService,
  input: {
    readonly kind: "TEXT" | "FILE" | "IMAGE";
    readonly title: string;
    readonly fileName: string;
    readonly byteSize: number;
    readonly contentType: string | null;
  },
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
    .pipe(Effect.mapError(toRpcError));

  if (snippet === undefined) {
    return yield* Effect.die(new Error("Snippet insert returned no row"));
  }

  return toApiSnippet(snippet);
});

const toRpcError = () =>
  new RpcError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Something went wrong. Please try again.",
  });

export class PlakkApiLive extends Context.Service<
  PlakkApiLive,
  {
    readonly getAccountStatus: Effect.Effect<AccountStatus>;
    readonly listSnippets: (input: {
      readonly limit: number;
    }) => Effect.Effect<{ readonly items: readonly ApiSnippet[] }, RpcError>;
    readonly createTextSnippet: (text: string) => Effect.Effect<ApiSnippet, RpcError>;
    readonly createStoredSnippet: (input: {
      readonly kind: "FILE" | "IMAGE";
      readonly title: string;
      readonly fileName: string;
      readonly byteSize: number;
      readonly contentType: string | null;
    }) => Effect.Effect<ApiSnippet, RpcError>;
    readonly deleteSnippet: (id: string) => Effect.Effect<void, RpcError>;
  }
>()("@plakk/web/api/PlakkApiLive") {
  static readonly Live = Layer.effect(
    PlakkApiLive,
    Effect.gen(function* () {
      const drizzle = yield* Drizzle;

      return PlakkApiLive.of({
        getAccountStatus: Effect.gen(function* () {
          yield* Effect.logInfo("Returning account status", { storageProvider });
          return accountStatus;
        }),
        listSnippets: Effect.fn("@plakk/web/api/PlakkApiLive.listSnippets")(function* (input) {
          yield* Effect.logInfo("Listing snippets", { limit: input.limit });
          const rows = yield* drizzle.db
            .select()
            .from(snippets)
            .where(
              and(eq(snippets.ownerWorkosUserId, ownerWorkosUserId), isNull(snippets.deletedAt)),
            )
            .orderBy(desc(snippets.createdAt))
            .limit(input.limit)
            .pipe(Effect.mapError(toRpcError));

          return { items: rows.map(toApiSnippet) };
        }),
        createTextSnippet: Effect.fn("@plakk/web/api/PlakkApiLive.createTextSnippet")(
          function* (text) {
            yield* Effect.logInfo("Creating text snippet", { byteSize: text.length });
            return yield* insertSnippet(drizzle, {
              kind: "TEXT",
              title: text,
              fileName: "text.txt",
              byteSize: new TextEncoder().encode(text).byteLength,
              contentType: "text/plain",
            });
          },
        ),
        createStoredSnippet: Effect.fn("@plakk/web/api/PlakkApiLive.createStoredSnippet")(
          function* (input) {
            yield* Effect.logInfo("Creating stored snippet metadata", {
              kind: input.kind,
              byteSize: input.byteSize,
            });
            return yield* insertSnippet(drizzle, input);
          },
        ),
        deleteSnippet: Effect.fn("@plakk/web/api/PlakkApiLive.deleteSnippet")(function* (id) {
          yield* Effect.logInfo("Deleting snippet", { id });
          const now = DateTime.toDateUtc(yield* DateTime.now);
          yield* drizzle.db
            .update(snippets)
            .set({ deletedAt: now, updatedAt: now })
            .where(and(eq(snippets.id, id), eq(snippets.ownerWorkosUserId, ownerWorkosUserId)))
            .pipe(Effect.mapError(toRpcError));
        }),
      });
    }),
  ).pipe(Layer.provide(Drizzle.Live));
}
