import { and, desc, Drizzle, eq, isNull, type DrizzleService } from "@plakk/db";
import { snippets } from "@plakk/db/schema";
import type { SnippetKind, StorageProvider } from "@plakk/shared";
import { PlakkApi, type AccountStatus, type PipeConnection } from "@plakk/shared/PlakkApi";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { toApiSnippet } from "./transformers/toApiSnippet.ts";

const storageProvider = "GOOGLE_DRIVE" as const;
// ponytail: single-tenant placeholder until web auth supplies the WorkOS user id.
const ownerWorkosUserId = "dev-workos-user";
const workosBaseUrl = "https://api.workos.com";
const accountStatus: AccountStatus = {
  canSync: true,
  storageProvider,
  blockedReasons: [],
};

const WorkosAuthorizeResponseSchema = Schema.Struct({ url: Schema.String });
const WorkosAuthorizeRequestJsonSchema = Schema.fromJsonString(
  Schema.Struct({ user_id: Schema.String }),
);
const WorkosConnectedAccountSchema = Schema.Struct({
  state: Schema.Literals(["connected", "needs_reauthorization"] as const),
});

class WorkosRequestError extends Schema.TaggedErrorClass<WorkosRequestError>()(
  "WorkosRequestError",
  {
    error: Schema.Defect(),
  },
) {}

class WorkosJsonError extends Schema.TaggedErrorClass<WorkosJsonError>()("WorkosJsonError", {
  error: Schema.Defect(),
}) {}

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

const workosRequest = Effect.fn("@plakk/web/api/PlakkApiLive.workosRequest")(function* (
  path: string,
  init?: RequestInit,
) {
  const apiKey = yield* Config.redacted("WORKOS_API_KEY");
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${Redacted.value(apiKey)}`);
  headers.set("Content-Type", "application/json");

  return yield* Effect.tryPromise({
    try: () =>
      fetch(`${workosBaseUrl}${path}`, {
        ...init,
        headers,
      }),
    catch: (error) => new WorkosRequestError({ error }),
  });
}, Effect.orDie);

const readWorkosJson = <S extends Schema.Constraint>(response: Response, schema: S) =>
  Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: (error) => new WorkosJsonError({ error }),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)), Effect.orDie);

const getWorkosUserId = Config.string("WORKOS_USER_ID");

const getProviderSlug = (provider: StorageProvider) => {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return Config.string("WORKOS_PIPES_GOOGLE_DRIVE_SLUG");
    case "ONE_DRIVE":
      return Config.string("WORKOS_PIPES_ONE_DRIVE_SLUG");
    case "DROPBOX":
      return Config.string("WORKOS_PIPES_DROPBOX_SLUG");
  }
};

const getConnectedAccountPath = Effect.fn("@plakk/web/api/PlakkApiLive.getConnectedAccountPath")(
  function* (provider: StorageProvider) {
    const userId = yield* getWorkosUserId;
    const slug = yield* getProviderSlug(provider);
    return `/user_management/users/${encodeURIComponent(userId)}/connected_accounts/${encodeURIComponent(slug)}`;
  },
  Effect.orDie,
);

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
    GetPipeConnectionUrl: Effect.fn("rpc.GetPipeConnectionUrl")(function* (input) {
      return yield* Effect.gen(function* () {
        const userId = yield* getWorkosUserId.pipe(Effect.orDie);
        const slug = yield* getProviderSlug(input.storageProvider).pipe(Effect.orDie);
        const body = yield* Schema.encodeUnknownEffect(WorkosAuthorizeRequestJsonSchema)({
          user_id: userId,
        }).pipe(Effect.orDie);
        const response = yield* workosRequest(
          `/data-integrations/${encodeURIComponent(slug)}/authorize`,
          {
            method: "POST",
            body,
          },
        );

        if (!response.ok) {
          yield* Effect.logError("WorkOS Pipes authorize failed", { status: response.status });
          return yield* Effect.die(new Error("WorkOS Pipes authorize failed"));
        }

        return yield* readWorkosJson(response, WorkosAuthorizeResponseSchema);
      }).pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
    }),
    GetPipeConnectionStatus: Effect.fn("rpc.GetPipeConnectionStatus")(function* (input) {
      return yield* Effect.gen(function* () {
        const response = yield* workosRequest(
          yield* getConnectedAccountPath(input.storageProvider),
        );

        if (response.status === 404) {
          return {
            storageProvider: input.storageProvider,
            status: "NOT_CONNECTED",
          } satisfies PipeConnection;
        }

        if (!response.ok) {
          yield* Effect.logError("WorkOS Pipes status failed", { status: response.status });
          return yield* Effect.die(new Error("WorkOS Pipes status failed"));
        }

        const account = yield* readWorkosJson(response, WorkosConnectedAccountSchema);
        return {
          storageProvider: input.storageProvider,
          status: account.state === "connected" ? "CONNECTED" : "NEEDS_REAUTHORIZATION",
        } satisfies PipeConnection;
      }).pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
    }),
    DisconnectPipe: Effect.fn("rpc.DisconnectPipe")(function* (input) {
      return yield* Effect.gen(function* () {
        const response = yield* workosRequest(
          yield* getConnectedAccountPath(input.storageProvider),
          {
            method: "DELETE",
          },
        );

        if (response.ok || response.status === 404) return;

        yield* Effect.logError("WorkOS Pipes disconnect failed", { status: response.status });
        return yield* Effect.die(new Error("WorkOS Pipes disconnect failed"));
      }).pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
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
