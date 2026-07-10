import { and, desc, Drizzle, eq, isNull, sql, type DrizzleService } from "@plakk/db";
import { snippets, type SnippetRow } from "@plakk/db/schema";
import {
  STORAGE_PROVIDERS,
  type SnippetKind,
  type SnippetUploadStatus,
  type StorageProvider,
} from "@plakk/shared";
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

const DEFAULT_STORAGE_PROVIDER = "GOOGLE_DRIVE" as const;
const WORKOS_BASE_URL = "https://api.workos.com";

const isStorageProvider = (value: string): value is StorageProvider =>
  STORAGE_PROVIDERS.includes(value as StorageProvider);

const WorkosAuthorizeResponseSchema = Schema.Struct({ url: Schema.String });
const WorkosConnectedAccountSchema = Schema.Struct({
  state: Schema.Literals(["connected", "needs_reauthorization"] as const),
});

export type CreateSnippetInput = {
  readonly id: string;
  readonly kind: Extract<SnippetKind, "TEXT" | "FILE" | "IMAGE">;
  readonly title: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly contentType: string | null;
  readonly storageProvider: StorageProvider;
  readonly storageObjectId: string | null;
};

export const insertSnippet = Effect.fn("@plakk/web/api/PlakkApiLive.insertSnippet")(function* (
  drizzle: DrizzleService,
  input: CreateSnippetInput,
) {
  const currentUser = yield* CurrentUser;
  const uploadStatus: SnippetUploadStatus = "UPLOADING";
  const [snippet] = yield* drizzle.db
    .insert(snippets)
    .values({
      ...input,
      ownerWorkosUserId: currentUser.id,
      uploadStatus,
    })
    .returning()
    .pipe(Effect.orDie);

  if (snippet === undefined) {
    return yield* Effect.die(new Error("Snippet insert returned no row"));
  }

  return toApiSnippet(snippet);
});

export const readSnippetContent = Effect.fn("@plakk/web/api/PlakkApiLive.readSnippetContent")(
  function* (
    drizzle: DrizzleService,
    storage: StorageProviderService["Service"],
    workosUserId: string,
    snippetId: string,
  ) {
    const [snippet] = yield* drizzle.db
      .select()
      .from(snippets)
      .where(
        and(
          eq(snippets.id, snippetId),
          eq(snippets.ownerWorkosUserId, workosUserId),
          eq(snippets.kind, "TEXT"),
          eq(snippets.uploadStatus, "READY"),
          isNull(snippets.deletedAt),
        ),
      )
      .limit(1)
      .pipe(Effect.orDie);

    if (snippet === undefined || snippet.ownerWorkosUserId !== workosUserId) {
      return yield* new RpcError({
        code: "NOT_FOUND",
        message: "Ready text snippet content was not found.",
      });
    }

    if (snippet.storageProvider === null && snippet.storageObjectId === null) {
      const bytes = new TextEncoder().encode(snippet.title);
      if (bytes.byteLength !== snippet.byteSize) {
        return yield* new RpcError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Legacy snippet size does not match its stored body.",
        });
      }
      return { bytes };
    }

    if (snippet.storageProvider === null || snippet.storageObjectId === null) {
      return yield* new RpcError({
        code: "NOT_FOUND",
        message: "Ready text snippet content was not found.",
      });
    }

    const bytes = yield* storage
      .downloadObject({
        storageProvider: snippet.storageProvider,
        storageObjectId: snippet.storageObjectId,
        expectedByteSize: snippet.byteSize,
        workosUserId,
      })
      .pipe(
        Effect.catchTags({
          StorageObjectNotFoundError: (error) =>
            Effect.fail(new RpcError({ code: "NOT_FOUND", message: error.message })),
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
    if (bytes.byteLength !== snippet.byteSize) {
      return yield* new RpcError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Stored object size does not match snippet metadata.",
      });
    }
    return { bytes };
  },
);

export const confirmTextSnippetUpload = Effect.fn(
  "@plakk/web/api/PlakkApiLive.confirmTextSnippetUpload",
)(function* (
  storage: StorageProviderService["Service"],
  snippet: SnippetRow,
  workosUserId: string,
  input: {
    readonly storageObjectId: string;
    readonly storageProvider?: StorageProvider;
  },
) {
  if (snippet.ownerWorkosUserId !== workosUserId || snippet.kind !== "TEXT") {
    return yield* new RpcError({
      code: "NOT_FOUND",
      message: "Finalizable text snippet not found.",
    });
  }
  const requestedProvider = input.storageProvider ?? snippet.storageProvider;
  const isLegacy =
    snippet.uploadStatus === "READY" &&
    snippet.storageProvider === null &&
    snippet.storageObjectId === null &&
    input.storageProvider !== undefined;
  const isPending =
    snippet.uploadStatus === "UPLOADING" &&
    snippet.storageProvider !== null &&
    input.storageProvider === undefined;
  if ((!isLegacy && !isPending) || requestedProvider === null) {
    return yield* new RpcError({
      code: "NOT_FOUND",
      message: "Finalizable text snippet not found.",
    });
  }

  const bytes = yield* storage
    .downloadObject({
      storageProvider: requestedProvider,
      storageObjectId: input.storageObjectId,
      expectedByteSize: snippet.byteSize,
      workosUserId,
    })
    .pipe(
      Effect.catchTags({
        StorageObjectNotFoundError: (error) =>
          Effect.fail(new RpcError({ code: "NOT_FOUND", message: error.message })),
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
  if (bytes.byteLength !== snippet.byteSize) {
    return yield* new RpcError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Stored object size does not match snippet metadata.",
    });
  }
  if (isLegacy) {
    const legacyBytes = new TextEncoder().encode(snippet.title);
    if (
      legacyBytes.byteLength !== bytes.byteLength ||
      legacyBytes.some((byte, index) => byte !== bytes[index])
    ) {
      return yield* new RpcError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Uploaded object does not match the legacy snippet body.",
      });
    }
  }
  return requestedProvider;
});

export const prepareSnippetUpload = Effect.fn("@plakk/web/api/PlakkApiLive.prepareSnippetUpload")(
  function* (
    drizzle: DrizzleService,
    storage: StorageProviderService["Service"],
    workosUserId: string,
    input: { readonly snippetId: string; readonly storageProvider: StorageProvider },
  ) {
    const [snippet] = yield* drizzle.db
      .select()
      .from(snippets)
      .where(
        and(
          eq(snippets.id, input.snippetId),
          eq(snippets.ownerWorkosUserId, workosUserId),
          isNull(snippets.deletedAt),
        ),
      )
      .limit(1)
      .pipe(Effect.orDie);
    const isLegacyText =
      snippet?.kind === "TEXT" &&
      snippet.uploadStatus === "READY" &&
      snippet.storageProvider === null &&
      snippet.storageObjectId === null;
    const isPendingUpload =
      snippet?.uploadStatus === "UPLOADING" &&
      snippet.storageProvider === input.storageProvider &&
      (snippet.kind === "TEXT" || snippet.kind === "FILE" || snippet.kind === "IMAGE");
    if (
      snippet === undefined ||
      snippet.ownerWorkosUserId !== workosUserId ||
      (!isLegacyText && !isPendingUpload)
    ) {
      return yield* new RpcError({
        code: "NOT_FOUND",
        message: "Uploadable snippet metadata was not found.",
      });
    }

    return yield* storage.prepareUpload({
      snippetId: snippet.id,
      storageProvider: input.storageProvider,
      fileName: snippet.kind === "TEXT" ? `${snippet.id}.txt` : snippet.fileName,
      byteSize: snippet.byteSize,
      contentType: snippet.kind === "TEXT" ? "text/plain; charset=utf-8" : snippet.contentType,
      workosUserId,
    });
  },
);

type UpdateSnippetUploadInput =
  | {
      readonly id: string;
      readonly uploadStatus: "READY";
      readonly storageObjectId: string;
      readonly storageProvider?: StorageProvider;
    }
  | {
      readonly id: string;
      readonly uploadStatus: "FAILED";
      readonly storageObjectId?: string | null;
    };

export const updateStoredSnippetUpload = Effect.fn(
  "@plakk/web/api/PlakkApiLive.updateStoredSnippetUpload",
)(function* (
  drizzle: DrizzleService,
  storage: StorageProviderService["Service"],
  workosUserId: string,
  input: UpdateSnippetUploadInput,
) {
  const [current] = yield* drizzle.db
    .select()
    .from(snippets)
    .where(
      and(
        eq(snippets.id, input.id),
        eq(snippets.ownerWorkosUserId, workosUserId),
        isNull(snippets.deletedAt),
      ),
    )
    .limit(1)
    .pipe(Effect.orDie);
  if (
    current === undefined ||
    current.ownerWorkosUserId !== workosUserId ||
    current.deletedAt !== null ||
    (current.kind !== "TEXT" && current.kind !== "FILE" && current.kind !== "IMAGE")
  ) {
    return yield* new RpcError({ code: "NOT_FOUND", message: "Stored snippet not found." });
  }

  let finalizedProvider: StorageProvider | undefined;
  if (input.uploadStatus === "FAILED") {
    if (current.uploadStatus !== "UPLOADING") {
      return yield* new RpcError({
        code: "NOT_FOUND",
        message: "Pending stored snippet not found.",
      });
    }
  } else if (current.kind === "TEXT") {
    finalizedProvider = yield* confirmTextSnippetUpload(storage, current, workosUserId, {
      storageObjectId: input.storageObjectId,
      ...(input.storageProvider === undefined ? {} : { storageProvider: input.storageProvider }),
    });
  } else if (current.uploadStatus !== "UPLOADING" || "storageProvider" in input) {
    return yield* new RpcError({
      code: "NOT_FOUND",
      message: "Pending stored snippet not found.",
    });
  }

  const now = DateTime.toDateUtc(yield* DateTime.now);
  const [snippet] = yield* drizzle.db
    .update(snippets)
    .set({
      uploadStatus: input.uploadStatus,
      updatedAt: now,
      ...(input.storageObjectId !== undefined ? { storageObjectId: input.storageObjectId } : {}),
      ...(finalizedProvider === undefined
        ? {}
        : { storageProvider: finalizedProvider, title: "Text snippet" }),
    })
    .where(
      and(
        eq(snippets.id, input.id),
        eq(snippets.ownerWorkosUserId, workosUserId),
        isNull(snippets.deletedAt),
        eq(snippets.uploadStatus, current.uploadStatus),
        current.storageProvider === null
          ? isNull(snippets.storageProvider)
          : eq(snippets.storageProvider, current.storageProvider),
      ),
    )
    .returning()
    .pipe(Effect.orDie);

  if (snippet === undefined) {
    return yield* new RpcError({ code: "NOT_FOUND", message: "Stored snippet not found." });
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
    const configuredProvider = yield* Config.string("PLAKK_STORAGE_PROVIDER").pipe(
      Effect.orElseSucceed(() => DEFAULT_STORAGE_PROVIDER),
    );
    if (!isStorageProvider(configuredProvider)) {
      return yield* Effect.die(new Error("PLAKK_STORAGE_PROVIDER is invalid."));
    }
    const accountStatus: AccountStatus = {
      canSync: true,
      storageProvider: configuredProvider,
      blockedReasons: [],
    };
    yield* Effect.logInfo("Returning account status", {
      storageProvider: configuredProvider,
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
        return yield* storage
          .getDestinationUrl({
            storageProvider: input.storageProvider,
            workosUserId: currentUser.id,
          })
          .pipe(
            Effect.map(
              (externalDestinationUrl) =>
                ({
                  storageProvider: input.storageProvider,
                  status: "CONNECTED",
                  externalDestinationUrl,
                }) satisfies PipeConnection,
            ),
            Effect.catchTags({
              StorageNeedsReauthorizationError: () =>
                Effect.succeed({
                  storageProvider: input.storageProvider,
                  status: "NEEDS_REAUTHORIZATION",
                  externalDestinationUrl: null,
                } satisfies PipeConnection),
              StorageNotConnectedError: () =>
                Effect.succeed({
                  storageProvider: input.storageProvider,
                  status: "NOT_CONNECTED",
                  externalDestinationUrl: null,
                } satisfies PipeConnection),
              StorageCredentialsError: (error) =>
                Effect.fail(
                  new RpcError({ code: "INTERNAL_SERVER_ERROR", message: error.message }),
                ),
              StorageProviderError: (error) =>
                Effect.fail(
                  new RpcError({
                    code: "INTERNAL_SERVER_ERROR",
                    message: `${error.storageProvider}: ${error.message}`,
                  }),
                ),
            }),
          );
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
      const drizzle = yield* Drizzle;
      const storage = yield* StorageProviderService;
      const currentUser = yield* CurrentUser;
      return yield* prepareSnippetUpload(drizzle, storage, currentUser.id, input).pipe(
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
        .orderBy(
          desc(sql<boolean>`${snippets.kind} = 'TEXT' and ${snippets.storageProvider} is null`),
          desc(snippets.createdAt),
        )
        .limit(input.limit)
        .pipe(Effect.orDie);

      return { items: rows.map(toApiSnippet) };
    }).pipe(Effect.annotateSpans({ limit: input.limit }));
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
      return yield* insertSnippet(
        drizzle,
        input.kind === "TEXT"
          ? {
              ...input,
              title: "Text snippet",
              fileName: `${input.id}.txt`,
              contentType: "text/plain; charset=utf-8",
            }
          : input,
      );
    }).pipe(Effect.annotateSpans({ kind: input.kind }));
  }),
  UpdateStoredSnippetUploadStatus: Effect.fn("rpc.UpdateStoredSnippetUploadStatus")(
    function* (input) {
      return yield* Effect.gen(function* () {
        const drizzle = yield* Drizzle;
        const currentUser = yield* CurrentUser;
        const storage = yield* StorageProviderService;
        return yield* updateStoredSnippetUpload(drizzle, storage, currentUser.id, input);
      }).pipe(Effect.annotateSpans({ id: input.id }));
    },
  ),
  GetSnippetContent: Effect.fn("rpc.GetSnippetContent")(function* (input) {
    return yield* Effect.gen(function* () {
      const drizzle = yield* Drizzle;
      const currentUser = yield* CurrentUser;
      const storage = yield* StorageProviderService;
      return yield* readSnippetContent(drizzle, storage, currentUser.id, input.id);
    }).pipe(Effect.annotateSpans({ id: input.id }));
  }),
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
