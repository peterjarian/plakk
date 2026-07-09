import { and, desc, Drizzle, eq, isNull, or, type DrizzleService } from "@plakk/db";
import { snippets } from "@plakk/db/schema";
import type { SnippetKind, SnippetUploadStatus, StorageProvider } from "@plakk/shared";
import {
  AccountRpcs,
  CurrentUser,
  HealthRpcs,
  PlakkApi,
  SnippetRpcs,
  StorageRpcs,
  type AccountStatus,
  type PipeConnection,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { StorageProviderService } from "./storage/StorageProvider.ts";
import { getProviderSlug } from "./storage/getProviderSlug.ts";
import { toApiSnippet } from "./transformers/toApiSnippet.ts";

const STORAGE_PROVIDER = "GOOGLE_DRIVE" as const;
const WORKOS_BASE_URL = "https://api.workos.com";
const accountStatus: AccountStatus = {
  canSync: true,
  storageProvider: STORAGE_PROVIDER,
  blockedReasons: [],
};

const WorkosAuthorizeResponseSchema = Schema.Struct({ url: Schema.String });
const WorkosConnectedAccountSchema = Schema.Struct({
  state: Schema.Literals(["connected", "needs_reauthorization"] as const),
});

type CreateSnippetInputBase = {
  readonly id: string;
  readonly kind: Extract<SnippetKind, "TEXT" | "FILE" | "IMAGE">;
  readonly title: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly contentType: string | null;
};

type CreateSnippetInput =
  | (CreateSnippetInputBase & { readonly kind: "TEXT" })
  | (CreateSnippetInputBase & {
      readonly kind: Extract<SnippetKind, "FILE" | "IMAGE">;
      readonly storageProvider: StorageProvider;
      readonly storageObjectId: string | null;
    });

const insertSnippet = Effect.fn("@plakk/web/api/PlakkApiLive.insertSnippet")(function* (
  drizzle: DrizzleService,
  input: CreateSnippetInput,
) {
  const currentUser = yield* CurrentUser;
  const storage =
    input.kind === "TEXT"
      ? { storageProvider: null, storageObjectId: null }
      : { storageProvider: input.storageProvider, storageObjectId: input.storageObjectId };
  const uploadStatus: SnippetUploadStatus = input.kind === "TEXT" ? "READY" : "UPLOADING";
  const [snippet] = yield* drizzle.db
    .insert(snippets)
    .values({
      ...input,
      ownerWorkosUserId: currentUser.id,
      ...storage,
      uploadStatus,
    })
    .returning()
    .pipe(Effect.orDie);

  if (snippet === undefined) {
    return yield* Effect.die(new Error("Snippet insert returned no row"));
  }

  return toApiSnippet(snippet);
});

const getConnectedAccountUrl = (provider: StorageProvider, workosUserId: string) =>
  `${WORKOS_BASE_URL}/user_management/users/${encodeURIComponent(workosUserId)}/connected_accounts/${encodeURIComponent(getProviderSlug(provider))}`;

const HealthLive = HealthRpcs.of({
  Ping: () =>
    Effect.succeed({ ok: true }).pipe(
      Effect.tap(() => Effect.logInfo("Ping")),
      Effect.withSpan("rpc.Ping"),
    ),
});

const AccountLive = AccountRpcs.of({
  GetAccountStatus: Effect.fn("rpc.GetAccountStatus")(function* () {
    const currentUser = yield* CurrentUser;
    yield* Effect.logInfo("Returning account status", {
      storageProvider: STORAGE_PROVIDER,
      workosUserId: currentUser.id,
    });
    return accountStatus;
  }),
});

const StorageLive = StorageRpcs.of({
  GetPipeConnectionUrl: Effect.fn("rpc.GetPipeConnectionUrl")(function* (input) {
    return yield* Effect.gen(function* () {
      const apiKey = yield* Config.redacted("WORKOS_API_KEY").pipe(Effect.orDie);
      const currentUser = yield* CurrentUser;
      const request = yield* HttpClientRequest.post(
        `${WORKOS_BASE_URL}/data-integrations/${encodeURIComponent(getProviderSlug(input.storageProvider))}/authorize`,
      ).pipe(
        HttpClientRequest.bearerToken(Redacted.value(apiKey)),
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.bodyJson({ user_id: currentUser.id }),
        Effect.orDie,
      );
      const response = yield* HttpClient.execute(request).pipe(Effect.orDie);

      if (response.status < 200 || response.status >= 300) {
        yield* Effect.logError("WorkOS Pipes authorize failed", { status: response.status });
        return yield* Effect.die(new Error("WorkOS Pipes authorize failed"));
      }

      return yield* HttpClientResponse.schemaBodyJson(WorkosAuthorizeResponseSchema)(response).pipe(
        Effect.orDie,
      );
    }).pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
  }),
  GetPipeConnectionStatus: Effect.fn("rpc.GetPipeConnectionStatus")(function* (input) {
    return yield* Effect.gen(function* () {
      const apiKey = yield* Config.redacted("WORKOS_API_KEY").pipe(Effect.orDie);
      const currentUser = yield* CurrentUser;
      const response = yield* HttpClient.get(
        getConnectedAccountUrl(input.storageProvider, currentUser.id),
        {
          headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
        },
      ).pipe(Effect.orDie);

      if (response.status === 404) {
        return {
          storageProvider: input.storageProvider,
          status: "NOT_CONNECTED",
          externalDestinationUrl: null,
        } satisfies PipeConnection;
      }

      if (response.status < 200 || response.status >= 300) {
        yield* Effect.logError("WorkOS Pipes status failed", { status: response.status });
        return yield* Effect.die(new Error("WorkOS Pipes status failed"));
      }

      const account = yield* HttpClientResponse.schemaBodyJson(WorkosConnectedAccountSchema)(
        response,
      ).pipe(Effect.orDie);
      if (account.state === "connected") {
        const storage = yield* StorageProviderService;
        const externalDestinationUrl = yield* storage
          .getDestinationUrl({
            storageProvider: input.storageProvider,
            workosUserId: currentUser.id,
          })
          .pipe(Effect.orDie);
        return {
          storageProvider: input.storageProvider,
          status: "CONNECTED",
          externalDestinationUrl,
        } satisfies PipeConnection;
      }

      return {
        storageProvider: input.storageProvider,
        status: "NEEDS_REAUTHORIZATION",
        externalDestinationUrl: null,
      } satisfies PipeConnection;
    }).pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
  }),
  DisconnectPipe: Effect.fn("rpc.DisconnectPipe")(function* (input) {
    return yield* Effect.gen(function* () {
      const apiKey = yield* Config.redacted("WORKOS_API_KEY").pipe(Effect.orDie);
      const currentUser = yield* CurrentUser;
      const response = yield* HttpClient.del(
        getConnectedAccountUrl(input.storageProvider, currentUser.id),
        {
          headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
        },
      ).pipe(Effect.orDie);

      if (response.status === 404 || (response.status >= 200 && response.status < 300)) return;

      yield* Effect.logError("WorkOS Pipes disconnect failed", { status: response.status });
      return yield* Effect.die(new Error("WorkOS Pipes disconnect failed"));
    }).pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
  }),
  PrepareStoredSnippetUpload: Effect.fn("rpc.PrepareStoredSnippetUpload")(function* (input) {
    return yield* Effect.gen(function* () {
      const storage = yield* StorageProviderService;
      const currentUser = yield* CurrentUser;

      return yield* storage.prepareUpload({ ...input, workosUserId: currentUser.id }).pipe(
        Effect.catchTags({
          StorageNotConnectedError: (error) =>
            Effect.fail(new RpcError({ code: "FORBIDDEN", message: error.message })),
          StorageNeedsReauthorizationError: (error) =>
            Effect.fail(new RpcError({ code: "FORBIDDEN", message: error.message })),
          StorageCredentialsError: (error) =>
            Effect.fail(new RpcError({ code: "INTERNAL_SERVER_ERROR", message: error.message })),
          StorageProviderError: (error) =>
            Effect.fail(
              new RpcError({
                code: "INTERNAL_SERVER_ERROR",
                message: `${error.storageProvider}: ${error.message}`,
              }),
            ),
        }),
      );
    }).pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
  }),
});

const SnippetsLive = SnippetRpcs.of({
  ListSnippets: Effect.fn("rpc.ListSnippets")(function* (input) {
    return yield* Effect.gen(function* () {
      const drizzle = yield* Drizzle;
      const currentUser = yield* CurrentUser;

      yield* Effect.logInfo("Listing snippets", { limit: input.limit });
      const rows = yield* drizzle.db
        .select()
        .from(snippets)
        .where(and(eq(snippets.ownerWorkosUserId, currentUser.id), isNull(snippets.deletedAt)))
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
      const storage = yield* StorageProviderService;
      const currentUser = yield* CurrentUser;

      yield* Effect.logInfo("Creating stored snippet metadata", {
        kind: input.kind,
        byteSize: input.byteSize,
      });
      yield* storage
        .ensureConnected({
          storageProvider: input.storageProvider,
          workosUserId: currentUser.id,
        })
        .pipe(
          Effect.catchTags({
            StorageNotConnectedError: (error) =>
              Effect.fail(new RpcError({ code: "FORBIDDEN", message: error.message })),
            StorageNeedsReauthorizationError: (error) =>
              Effect.fail(new RpcError({ code: "FORBIDDEN", message: error.message })),
            StorageCredentialsError: (error) =>
              Effect.fail(new RpcError({ code: "INTERNAL_SERVER_ERROR", message: error.message })),
          }),
        );
      return yield* insertSnippet(drizzle, input);
    }).pipe(Effect.annotateSpans({ kind: input.kind }));
  }),
  UpdateStoredSnippetUploadStatus: Effect.fn("rpc.UpdateStoredSnippetUploadStatus")(
    function* (input) {
      return yield* Effect.gen(function* () {
        const drizzle = yield* Drizzle;
        const currentUser = yield* CurrentUser;
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const [snippet] = yield* drizzle.db
          .update(snippets)
          .set({
            uploadStatus: input.uploadStatus,
            updatedAt: now,
            ...(input.storageObjectId !== undefined
              ? { storageObjectId: input.storageObjectId }
              : {}),
          })
          .where(
            and(
              eq(snippets.id, input.id),
              eq(snippets.ownerWorkosUserId, currentUser.id),
              or(eq(snippets.kind, "FILE"), eq(snippets.kind, "IMAGE")),
            ),
          )
          .returning()
          .pipe(Effect.orDie);

        if (snippet === undefined) {
          return yield* new RpcError({
            code: "NOT_FOUND",
            message: "Stored snippet not found.",
          });
        }

        return toApiSnippet(snippet);
      }).pipe(Effect.annotateSpans({ id: input.id }));
    },
  ),
  DeleteSnippet: Effect.fn("rpc.DeleteSnippet")(function* (input) {
    return yield* Effect.gen(function* () {
      const drizzle = yield* Drizzle;
      const currentUser = yield* CurrentUser;

      yield* Effect.logInfo("Deleting snippet", { id: input.id });
      const now = DateTime.toDateUtc(yield* DateTime.now);
      yield* drizzle.db
        .update(snippets)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(snippets.id, input.id), eq(snippets.ownerWorkosUserId, currentUser.id)))
        .pipe(Effect.orDie);
    }).pipe(Effect.annotateSpans({ id: input.id }));
  }),
});

export const PlakkApiLive = PlakkApi.toLayer(
  PlakkApi.of({
    ...HealthLive,
    ...AccountLive,
    ...StorageLive,
    ...SnippetsLive,
  }),
);
