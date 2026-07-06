import { Database, Snippets, type DatabaseService, type DbSnippet } from "@plakk/db";
import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Context from "effect/Context";
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

const titleFromText = (text: string) =>
  text.trim().split(/\s+/).slice(0, 8).join(" ") || "Untitled note";

const toApiSnippet = (snippet: DbSnippet): ApiSnippet => ({
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
  database: DatabaseService,
  input: {
    readonly kind: "TEXT" | "FILE" | "IMAGE";
    readonly title: string;
    readonly fileName: string;
    readonly byteSize: number;
    readonly contentType: string | null;
  },
) {
  const snippet = yield* Snippets.insertSnippet({
    ...input,
    ownerWorkosUserId,
    storageProvider,
    storageObjectId: placeholderStorageObjectId(),
  }).pipe(Effect.provideService(Database, database), Effect.mapError(toRpcError));

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
      const database = yield* Database;

      return PlakkApiLive.of({
        getAccountStatus: Effect.gen(function* () {
          yield* Effect.logInfo("Returning account status", { storageProvider });
          return accountStatus;
        }),
        listSnippets: Effect.fn("@plakk/web/api/PlakkApiLive.listSnippets")(function* (input) {
          yield* Effect.logInfo("Listing snippets", { limit: input.limit });
          const rows = yield* Snippets.listSnippets({ ownerWorkosUserId, limit: input.limit }).pipe(
            Effect.provideService(Database, database),
            Effect.mapError(toRpcError),
          );

          return { items: rows.map(toApiSnippet) };
        }),
        createTextSnippet: Effect.fn("@plakk/web/api/PlakkApiLive.createTextSnippet")(
          function* (text) {
            const title = titleFromText(text);
            yield* Effect.logInfo("Creating text snippet", { byteSize: text.length });
            return yield* insertSnippet(database, {
              kind: "TEXT",
              title,
              fileName: `${title}.txt`,
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
            return yield* insertSnippet(database, input);
          },
        ),
        deleteSnippet: Effect.fn("@plakk/web/api/PlakkApiLive.deleteSnippet")(function* (id) {
          yield* Effect.logInfo("Deleting snippet", { id });
          yield* Snippets.deleteSnippet({ ownerWorkosUserId, id }).pipe(
            Effect.provideService(Database, database),
            Effect.mapError(toRpcError),
          );
        }),
      });
    }),
  ).pipe(Layer.provide(Database.Live));
}
