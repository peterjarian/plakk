import { and, Drizzle, eq, gt, isNull, lte, or, type DrizzleService } from "@plakk/db";
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
  PreparedStorageUploadSchema,
  SnippetRpcs,
  StorageRpcs,
  type AccountStatus,
  type PipeConnection,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { StorageProviderService } from "./storage/StorageProvider.ts";
import { getProviderSlug } from "./storage/getProviderSlug.ts";
import {
  appendSnippetChange,
  getSnippetSnapshot,
  pullSnippetChanges,
} from "./SnippetChangeFeed.ts";
import { snippetChangeRpcStream } from "./SnippetChangeWakes.ts";
import { toApiSnippet } from "./transformers/toApiSnippet.ts";

const DEFAULT_STORAGE_PROVIDER = "GOOGLE_DRIVE" as const;
const WORKOS_BASE_URL = "https://api.workos.com";
const UPLOAD_LEASE_MILLISECONDS = 60_000;

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
  readonly clientMutationId?: string;
};

export type UploadLeaseDecision =
  | "ACQUIRE"
  | "RENEW"
  | "INTERRUPT_AND_REACQUIRE"
  | "BUSY"
  | "NOT_OWNER"
  | "NOT_PENDING";

export const decideUploadLease = (
  snippet: SnippetRow,
  mutationId: string,
  now: Date,
): UploadLeaseDecision => {
  if (snippet.clientMutationId !== mutationId) return "NOT_OWNER";
  if (
    snippet.uploadStatus !== "UPLOADING" &&
    snippet.uploadStatus !== "INTERRUPTED" &&
    snippet.uploadStatus !== "FAILED"
  ) {
    return "NOT_PENDING";
  }
  if (
    snippet.uploadStatus === "INTERRUPTED" ||
    snippet.uploadStatus === "FAILED" ||
    snippet.uploadLeaseId === null
  )
    return "ACQUIRE";
  if (
    snippet.uploadLeaseExpiresAt !== null &&
    snippet.uploadLeaseExpiresAt.getTime() <= now.getTime()
  ) {
    return "INTERRUPT_AND_REACQUIRE";
  }
  return snippet.uploadLeaseId === mutationId ? "RENEW" : "BUSY";
};

export const insertSnippet = Effect.fn("@plakk/web/api/PlakkApiLive.insertSnippet")(function* (
  drizzle: DrizzleService,
  input: CreateSnippetInput,
) {
  const currentUser = yield* CurrentUser;
  const uploadStatus: SnippetUploadStatus = "UPLOADING";
  const leaseStartedAt = yield* DateTime.now;
  const uploadLeaseExpiresAt =
    input.clientMutationId === undefined
      ? null
      : DateTime.toDateUtc(DateTime.addDuration(leaseStartedAt, UPLOAD_LEASE_MILLISECONDS));
  const snippet = yield* drizzle.db
    .transaction((tx) =>
      Effect.gen(function* () {
        const [inserted] = yield* tx
          .insert(snippets)
          .values({
            ...input,
            ownerWorkosUserId: currentUser.id,
            uploadStatus,
            ...(input.clientMutationId === undefined
              ? {}
              : {
                  uploadLeaseId: input.clientMutationId,
                  uploadLeaseExpiresAt,
                }),
          })
          .onConflictDoNothing()
          .returning();
        if (inserted !== undefined) {
          yield* appendSnippetChange(tx, { type: "UPSERT", snippet: inserted });
        }
        return inserted;
      }),
    )
    .pipe(Effect.orDie);

  if (snippet === undefined) {
    const [existing] = yield* drizzle.db
      .select()
      .from(snippets)
      .where(
        and(
          eq(snippets.ownerWorkosUserId, currentUser.id),
          input.clientMutationId === undefined
            ? eq(snippets.id, input.id)
            : or(eq(snippets.id, input.id), eq(snippets.clientMutationId, input.clientMutationId)),
        ),
      )
      .limit(1)
      .pipe(Effect.orDie);
    if (
      existing === undefined ||
      existing.id !== input.id ||
      existing.clientMutationId !== (input.clientMutationId ?? null) ||
      existing.kind !== input.kind ||
      existing.byteSize !== input.byteSize ||
      existing.storageProvider !== input.storageProvider
    ) {
      return yield* new RpcError({
        code: "CONFLICT",
        message: "Snippet identifier is already used by another mutation.",
      });
    }
    return toApiSnippet(existing);
  }

  return toApiSnippet(snippet);
});

const withContentUrls = Effect.fn("@plakk/web/api/PlakkApiLive.withContentUrls")(function* (
  storage: StorageProviderService["Service"],
  snippet: SnippetRow,
  workosUserId: string,
) {
  const result = toApiSnippet(snippet);
  if (
    snippet.uploadStatus !== "READY" ||
    snippet.storageProvider === null ||
    snippet.storageObjectId === null
  ) {
    return result;
  }

  const contentUrl = yield* storage
    .getDownloadUrl({
      storageProvider: snippet.storageProvider,
      storageObjectId: snippet.storageObjectId,
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
  return {
    ...result,
    contentUrl,
    thumbnailUrl: snippet.kind === "IMAGE" ? contentUrl : null,
  };
});

export const getSnippetCopyPayload = Effect.fn("@plakk/web/api/PlakkApiLive.getSnippetCopyPayload")(
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
          eq(snippets.uploadStatus, "READY"),
          isNull(snippets.deletedAt),
        ),
      )
      .limit(1)
      .pipe(Effect.orDie);

    if (
      snippet === undefined ||
      (snippet.kind !== "TEXT" && snippet.kind !== "FILE" && snippet.kind !== "IMAGE") ||
      snippet.storageProvider === null ||
      snippet.storageObjectId === null
    ) {
      return yield* new RpcError({ code: "NOT_FOUND", message: "Ready snippet was not found." });
    }

    const download = yield* storage
      .getDownloadTarget({
        storageProvider: snippet.storageProvider,
        storageObjectId: snippet.storageObjectId,
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

    return {
      kind: snippet.kind,
      storageProvider: snippet.storageProvider,
      fileName: snippet.fileName,
      contentType: snippet.contentType,
      byteSize: snippet.byteSize,
      download,
    };
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
    (snippet.uploadStatus === "UPLOADING" || snippet.uploadStatus === "INTERRUPTED") &&
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
    input: {
      readonly snippetId: string;
      readonly storageProvider: StorageProvider;
      readonly mutationId?: string;
      readonly replacePreparationGeneration?: number;
    },
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
      (snippet?.uploadStatus === "UPLOADING" ||
        snippet?.uploadStatus === "INTERRUPTED" ||
        (snippet?.uploadStatus === "FAILED" && input.mutationId !== undefined)) &&
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

    let leaseExpiresAt: string | undefined;
    if (snippet.kind === "TEXT" && input.mutationId !== undefined) {
      leaseExpiresAt = yield* acquireSnippetUploadLease(
        drizzle,
        workosUserId,
        snippet,
        input.mutationId,
      );
      const preparationNow = DateTime.toEpochMillis(yield* DateTime.now);
      const storedPreparation =
        snippet.uploadPreparation === null
          ? Option.none()
          : Schema.decodeUnknownOption(PreparedStorageUploadSchema)(snippet.uploadPreparation);
      if (
        Option.isSome(storedPreparation) &&
        snippet.uploadPreparationGeneration !== null &&
        (input.replacePreparationGeneration === undefined ||
          input.replacePreparationGeneration !== snippet.uploadPreparationGeneration) &&
        (storedPreparation.value.expiresAt === null ||
          Date.parse(storedPreparation.value.expiresAt) > preparationNow)
      ) {
        return {
          ...storedPreparation.value,
          leaseExpiresAt,
          preparationGeneration: snippet.uploadPreparationGeneration,
          resume: true as const,
        };
      }
    }

    const prepared = yield* storage.prepareUpload({
      snippetId: snippet.id,
      storageProvider: input.storageProvider,
      fileName: snippet.kind === "TEXT" ? `${snippet.id}.txt` : snippet.fileName,
      byteSize: snippet.byteSize,
      contentType: snippet.kind === "TEXT" ? "text/plain; charset=utf-8" : snippet.contentType,
      workosUserId,
    });
    if (leaseExpiresAt === undefined || input.mutationId === undefined) return prepared;

    const preparationGeneration = (snippet.uploadPreparationGeneration ?? 0) + 1;
    const [persisted] = yield* drizzle.db
      .update(snippets)
      .set({ uploadPreparation: prepared, uploadPreparationGeneration: preparationGeneration })
      .where(
        and(
          eq(snippets.id, snippet.id),
          eq(snippets.ownerWorkosUserId, workosUserId),
          eq(snippets.uploadStatus, "UPLOADING"),
          eq(snippets.uploadLeaseId, input.mutationId),
          ...(input.replacePreparationGeneration === undefined
            ? []
            : [eq(snippets.uploadPreparationGeneration, input.replacePreparationGeneration)]),
        ),
      )
      .returning()
      .pipe(Effect.orDie);
    if (persisted === undefined) {
      return yield* new RpcError({ code: "CONFLICT", message: "Upload lease changed. Retry." });
    }
    return { ...prepared, leaseExpiresAt, preparationGeneration };
  },
);

export const acquireSnippetUploadLease = Effect.fn(
  "@plakk/web/api/PlakkApiLive.acquireSnippetUploadLease",
)(function* (
  drizzle: DrizzleService,
  workosUserId: string,
  current: SnippetRow,
  mutationId: string,
) {
  const nowDateTime = yield* DateTime.now;
  const now = DateTime.toDateUtc(nowDateTime);
  const decision = decideUploadLease(current, mutationId, now);
  if (decision === "NOT_OWNER" || decision === "NOT_PENDING") {
    return yield* new RpcError({ code: "NOT_FOUND", message: "Pending upload was not found." });
  }
  if (decision === "BUSY") {
    return yield* new RpcError({
      code: "CONFLICT",
      message: "This upload is active on another device.",
    });
  }
  const expiresAt = DateTime.toDateUtc(
    DateTime.addDuration(nowDateTime, UPLOAD_LEASE_MILLISECONDS),
  );
  const updated = yield* drizzle.db
    .transaction((tx) =>
      Effect.gen(function* () {
        let expectedStatus = current.uploadStatus;
        if (decision === "INTERRUPT_AND_REACQUIRE") {
          const [interrupted] = yield* tx
            .update(snippets)
            .set({
              uploadStatus: "INTERRUPTED",
              uploadLeaseId: null,
              uploadLeaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(snippets.id, current.id),
                eq(snippets.ownerWorkosUserId, workosUserId),
                eq(snippets.uploadStatus, "UPLOADING"),
                current.uploadLeaseId === null
                  ? isNull(snippets.uploadLeaseId)
                  : eq(snippets.uploadLeaseId, current.uploadLeaseId),
                current.uploadLeaseExpiresAt === null
                  ? isNull(snippets.uploadLeaseExpiresAt)
                  : eq(snippets.uploadLeaseExpiresAt, current.uploadLeaseExpiresAt),
              ),
            )
            .returning();
          if (interrupted === undefined) return null;
          yield* appendSnippetChange(tx, { type: "UPSERT", snippet: interrupted });
          expectedStatus = "INTERRUPTED";
        }

        const [leased] = yield* tx
          .update(snippets)
          .set({
            uploadStatus: "UPLOADING",
            uploadLeaseId: mutationId,
            uploadLeaseExpiresAt: expiresAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(snippets.id, current.id),
              eq(snippets.ownerWorkosUserId, workosUserId),
              eq(snippets.uploadStatus, expectedStatus),
              eq(snippets.clientMutationId, mutationId),
              ...(decision === "RENEW"
                ? [eq(snippets.uploadLeaseId, mutationId), gt(snippets.uploadLeaseExpiresAt, now)]
                : decision === "ACQUIRE" && expectedStatus === "UPLOADING"
                  ? [isNull(snippets.uploadLeaseId)]
                  : []),
            ),
          )
          .returning();
        if (leased !== undefined && expectedStatus !== "UPLOADING") {
          yield* appendSnippetChange(tx, { type: "UPSERT", snippet: leased });
        }
        return leased ?? null;
      }),
    )
    .pipe(Effect.orDie);
  if (updated === null) {
    return yield* new RpcError({ code: "CONFLICT", message: "Upload lease changed. Retry." });
  }
  return expiresAt.toISOString();
});

export const heartbeatStoredSnippetUpload = Effect.fn(
  "@plakk/web/api/PlakkApiLive.heartbeatStoredSnippetUpload",
)(function* (
  drizzle: DrizzleService,
  workosUserId: string,
  input: { readonly id: string; readonly mutationId: string },
) {
  const nowDateTime = yield* DateTime.now;
  const now = DateTime.toDateUtc(nowDateTime);
  const expiresAt = DateTime.toDateUtc(
    DateTime.addDuration(nowDateTime, UPLOAD_LEASE_MILLISECONDS),
  );
  const [updated] = yield* drizzle.db
    .update(snippets)
    .set({ uploadLeaseExpiresAt: expiresAt })
    .where(
      and(
        eq(snippets.id, input.id),
        eq(snippets.ownerWorkosUserId, workosUserId),
        eq(snippets.uploadStatus, "UPLOADING"),
        eq(snippets.uploadLeaseId, input.mutationId),
        gt(snippets.uploadLeaseExpiresAt, now),
      ),
    )
    .returning()
    .pipe(Effect.orDie);
  if (updated === undefined) {
    yield* interruptExpiredSnippetUploads(drizzle, workosUserId);
    return yield* new RpcError({ code: "CONFLICT", message: "Upload lease expired." });
  }
  return { leaseExpiresAt: expiresAt.toISOString() };
});

export const interruptExpiredSnippetUploads = Effect.fn(
  "@plakk/web/api/PlakkApiLive.interruptExpiredSnippetUploads",
)(function* (drizzle: DrizzleService, workosUserId: string) {
  const now = DateTime.toDateUtc(yield* DateTime.now);
  return yield* drizzle.db
    .transaction((tx) =>
      Effect.gen(function* () {
        const interrupted = yield* tx
          .update(snippets)
          .set({
            uploadStatus: "INTERRUPTED",
            uploadLeaseId: null,
            uploadLeaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(snippets.ownerWorkosUserId, workosUserId),
              eq(snippets.uploadStatus, "UPLOADING"),
              lte(snippets.uploadLeaseExpiresAt, now),
            ),
          )
          .returning();
        yield* Effect.forEach(
          interrupted,
          (snippet) => appendSnippetChange(tx, { type: "UPSERT", snippet }),
          { discard: true },
        );
        return interrupted.length;
      }),
    )
    .pipe(Effect.orDie);
});

type UpdateSnippetUploadInput =
  | {
      readonly id: string;
      readonly uploadStatus: "UPLOADING" | "INTERRUPTED";
      readonly mutationId?: string;
    }
  | {
      readonly id: string;
      readonly uploadStatus: "READY";
      readonly storageObjectId: string;
      readonly storageProvider?: StorageProvider;
      readonly mutationId?: string;
    }
  | {
      readonly id: string;
      readonly uploadStatus: "FAILED";
      readonly storageObjectId?: string | null;
      readonly mutationId?: string;
      readonly errorMessage?: string;
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
  if (
    current.kind === "TEXT" &&
    current.clientMutationId !== null &&
    input.uploadStatus !== "INTERRUPTED" &&
    (!("mutationId" in input) || input.mutationId !== current.clientMutationId)
  ) {
    return yield* new RpcError({ code: "CONFLICT", message: "Upload lease is not owned." });
  }

  if (
    current.kind === "TEXT" &&
    current.clientMutationId !== null &&
    current.uploadStatus === input.uploadStatus &&
    (input.uploadStatus === "FAILED" ||
      (input.uploadStatus === "READY" && current.storageObjectId === input.storageObjectId))
  ) {
    return yield* withContentUrls(storage, current, workosUserId).pipe(
      Effect.orElseSucceed(() => toApiSnippet(current)),
    );
  }

  const validatesDurableTextLease =
    current.kind === "TEXT" &&
    current.clientMutationId !== null &&
    (input.uploadStatus === "READY" || input.uploadStatus === "FAILED");
  const validationTime = DateTime.toDateUtc(yield* DateTime.now);
  if (
    validatesDurableTextLease &&
    (current.uploadStatus !== "UPLOADING" ||
      current.uploadLeaseId !== input.mutationId ||
      current.uploadLeaseExpiresAt === null ||
      current.uploadLeaseExpiresAt.getTime() <= validationTime.getTime())
  ) {
    yield* interruptExpiredSnippetUploads(drizzle, workosUserId);
    return yield* new RpcError({ code: "CONFLICT", message: "Upload lease expired." });
  }

  let finalizedProvider: StorageProvider | undefined;
  if (input.uploadStatus === "READY") {
    if (current.kind === "TEXT") {
      finalizedProvider = yield* confirmTextSnippetUpload(storage, current, workosUserId, {
        storageObjectId: input.storageObjectId,
        ...(input.storageProvider === undefined ? {} : { storageProvider: input.storageProvider }),
      });
    } else if (
      (current.uploadStatus !== "UPLOADING" && current.uploadStatus !== "INTERRUPTED") ||
      "storageProvider" in input
    ) {
      return yield* new RpcError({
        code: "NOT_FOUND",
        message: "Pending stored snippet not found.",
      });
    }
  } else if (input.uploadStatus === "FAILED") {
    if (current.uploadStatus !== "UPLOADING" && current.uploadStatus !== "INTERRUPTED") {
      return yield* new RpcError({
        code: "NOT_FOUND",
        message: "Pending stored snippet not found.",
      });
    }
  } else if (input.uploadStatus === "INTERRUPTED") {
    if (current.uploadStatus !== "UPLOADING") {
      return yield* new RpcError({
        code: "NOT_FOUND",
        message: "Uploading stored snippet not found.",
      });
    }
  } else if (input.uploadStatus === "UPLOADING") {
    if (current.uploadStatus !== "INTERRUPTED") {
      return yield* new RpcError({
        code: "NOT_FOUND",
        message: "Interrupted stored snippet not found.",
      });
    }
  }

  const now = DateTime.toDateUtc(yield* DateTime.now);
  const snippet = yield* drizzle.db
    .transaction((tx) =>
      Effect.gen(function* () {
        const [updated] = yield* tx
          .update(snippets)
          .set({
            uploadStatus: input.uploadStatus,
            updatedAt: now,
            ...("storageObjectId" in input && input.storageObjectId !== undefined
              ? { storageObjectId: input.storageObjectId }
              : {}),
            ...(finalizedProvider === undefined
              ? {}
              : { storageProvider: finalizedProvider, title: "Text snippet" }),
            ...(input.uploadStatus === "READY" || input.uploadStatus === "FAILED"
              ? {
                  uploadLeaseId: null,
                  uploadLeaseExpiresAt: null,
                  uploadPreparation: null,
                  uploadPreparationGeneration: null,
                }
              : {}),
            ...(input.uploadStatus === "FAILED"
              ? { uploadFailureMessage: input.errorMessage ?? "Upload needs attention." }
              : input.uploadStatus === "READY"
                ? { uploadFailureMessage: null }
                : {}),
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
              ...(validatesDurableTextLease
                ? [
                    eq(snippets.uploadLeaseId, input.mutationId!),
                    gt(snippets.uploadLeaseExpiresAt, now),
                  ]
                : []),
            ),
          )
          .returning();
        if (updated !== undefined) {
          yield* appendSnippetChange(tx, { type: "UPSERT", snippet: updated });
        }
        return updated;
      }),
    )
    .pipe(Effect.orDie);

  if (snippet === undefined) {
    return yield* new RpcError({
      code: validatesDurableTextLease ? "CONFLICT" : "NOT_FOUND",
      message: validatesDurableTextLease
        ? "Upload lease changed before completion."
        : "Stored snippet not found.",
    });
  }
  return yield* withContentUrls(storage, snippet, workosUserId).pipe(
    Effect.orElseSucceed(() => toApiSnippet(snippet)),
  );
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
  CreateStoredSnippet: Effect.fn("rpc.CreateStoredSnippet")(function* (input) {
    return yield* Effect.gen(function* () {
      const drizzle = yield* Drizzle;
      const storage = yield* StorageProviderService;
      const currentUser = yield* CurrentUser;

      yield* Effect.logInfo("Creating stored snippet metadata", {
        kind: input.kind,
        byteSize: input.byteSize,
      });
      if (input.kind !== "TEXT") {
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
                Effect.fail(
                  new RpcError({ code: "INTERNAL_SERVER_ERROR", message: error.message }),
                ),
            }),
          );
      }
      return yield* insertSnippet(
        drizzle,
        input.kind === "TEXT"
          ? {
              id: input.id,
              kind: input.kind,
              byteSize: input.byteSize,
              storageProvider: input.storageProvider,
              storageObjectId: input.storageObjectId,
              clientMutationId: input.mutationId,
              title: "Text snippet",
              fileName: `${input.id}.txt`,
              contentType: "text/plain; charset=utf-8",
            }
          : input,
      );
    }).pipe(Effect.annotateSpans({ kind: input.kind }));
  }),
  GetSnippetSnapshot: Effect.fn("rpc.GetSnippetSnapshot")(function* () {
    const drizzle = yield* Drizzle;
    const currentUser = yield* CurrentUser;
    const storage = yield* StorageProviderService;
    yield* interruptExpiredSnippetUploads(drizzle, currentUser.id);
    const snapshot = yield* getSnippetSnapshot(drizzle, currentUser.id);
    return {
      cursor: snapshot.cursor,
      items: yield* Effect.forEach(snapshot.rows, (snippet) =>
        withContentUrls(storage, snippet, currentUser.id).pipe(
          Effect.orElseSucceed(() => toApiSnippet(snippet)),
        ),
      ),
    };
  }),
  PullSnippetChanges: Effect.fn("rpc.PullSnippetChanges")(function* (input) {
    return yield* Effect.gen(function* () {
      const drizzle = yield* Drizzle;
      const currentUser = yield* CurrentUser;
      yield* interruptExpiredSnippetUploads(drizzle, currentUser.id);
      return yield* pullSnippetChanges(drizzle, currentUser.id, input.cursor, input.limit);
    }).pipe(Effect.annotateSpans({ limit: input.limit }));
  }),
  SubscribeSnippetChanges: () => snippetChangeRpcStream,
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
  HeartbeatStoredSnippetUpload: Effect.fn("rpc.HeartbeatStoredSnippetUpload")(function* (input) {
    const drizzle = yield* Drizzle;
    const currentUser = yield* CurrentUser;
    return yield* heartbeatStoredSnippetUpload(drizzle, currentUser.id, input);
  }),
  GetSnippetCopyPayload: Effect.fn("rpc.GetSnippetCopyPayload")(function* (input) {
    return yield* Effect.gen(function* () {
      const drizzle = yield* Drizzle;
      const storage = yield* StorageProviderService;
      const currentUser = yield* CurrentUser;
      return yield* getSnippetCopyPayload(drizzle, storage, currentUser.id, input.id);
    }).pipe(Effect.annotateSpans({ id: input.id }));
  }),
  DeleteSnippet: Effect.fn("rpc.DeleteSnippet")(function* (input) {
    return yield* Effect.gen(function* () {
      const drizzle = yield* Drizzle;
      const currentUser = yield* CurrentUser;

      yield* Effect.logInfo("Deleting snippet", { id: input.id });
      const now = DateTime.toDateUtc(yield* DateTime.now);
      yield* drizzle.db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [deleted] = yield* tx
              .update(snippets)
              .set({ deletedAt: now, updatedAt: now })
              .where(
                and(
                  eq(snippets.id, input.id),
                  eq(snippets.ownerWorkosUserId, currentUser.id),
                  isNull(snippets.deletedAt),
                ),
              )
              .returning();
            if (deleted !== undefined) {
              yield* appendSnippetChange(tx, {
                type: "DELETE",
                ownerWorkosUserId: currentUser.id,
                snippetId: deleted.id,
              });
            }
          }),
        )
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
