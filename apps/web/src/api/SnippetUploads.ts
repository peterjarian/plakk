import { and, Drizzle, eq, gt, inArray, isNull, lte } from "@plakk/db";
import { snippets, type SnippetRow } from "@plakk/db/schema";
import type {
  ApiSnippet,
  CreateStoredSnippetPayload,
  PreparedStorageUpload,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { Context, DateTime, Effect, Layer } from "effect";

import { StorageProviderService } from "./storage/StorageProvider.ts";
import { mapStorageErrorsToRpc } from "./storage/mapStorageErrorsToRpc.ts";
import { appendSnippetChange } from "./SnippetChangeFeed.ts";
import { toApiSnippet } from "./transformers/toApiSnippet.ts";

export const UPLOAD_HEARTBEAT_DURATION = 60_000;
const EXPIRATION_BATCH_SIZE = 100;

type PrepareSnippetUploadInput = {
  readonly id: string;
  readonly mediaType: string | null;
};

type CompleteSnippetUploadInput = {
  readonly id: string;
  readonly storageObjectId: string;
};

const notFound = () =>
  new RpcError({ code: "NOT_FOUND", message: "Stored snippet upload was not found." });

const conflict = (message: string) => new RpcError({ code: "CONFLICT", message });

const sameCreate = (snippet: SnippetRow, input: CreateStoredSnippetPayload) =>
  snippet.id === input.id &&
  snippet.fileName === input.fileName &&
  snippet.byteSize === input.byteSize &&
  snippet.storageProvider === input.storageProvider;

const hasLiveUploadHeartbeat = (snippet: SnippetRow, now: Date) =>
  snippet.uploadStatus === "UPLOADING" &&
  snippet.uploadHeartbeatExpiresAt !== null &&
  snippet.uploadHeartbeatExpiresAt.getTime() > now.getTime();

export class SnippetUploads extends Context.Service<
  SnippetUploads,
  {
    readonly create: (
      ownerWorkosUserId: string,
      input: CreateStoredSnippetPayload,
    ) => Effect.Effect<ApiSnippet, RpcError>;
    readonly prepare: (
      ownerWorkosUserId: string,
      input: PrepareSnippetUploadInput,
    ) => Effect.Effect<PreparedStorageUpload, RpcError>;
    readonly heartbeat: (
      ownerWorkosUserId: string,
      id: string,
    ) => Effect.Effect<{ readonly expiresAt: string }, RpcError>;
    readonly fail: (ownerWorkosUserId: string, id: string) => Effect.Effect<ApiSnippet, RpcError>;
    readonly retry: (ownerWorkosUserId: string, id: string) => Effect.Effect<ApiSnippet, RpcError>;
    readonly complete: (
      ownerWorkosUserId: string,
      input: CompleteSnippetUploadInput,
    ) => Effect.Effect<ApiSnippet, RpcError>;
    readonly expire: Effect.Effect<number>;
  }
>()("@plakk/web/api/SnippetUploads") {
  static readonly Live = Layer.effect(
    SnippetUploads,
    Effect.gen(function* () {
      const drizzle = yield* Drizzle;
      const storage = yield* StorageProviderService;

      const findOwnedSnippet = Effect.fn("SnippetUploads.findOwnedSnippet")(function* (
        ownerWorkosUserId: string,
        id: string,
      ) {
        const [snippet] = yield* drizzle.db
          .select()
          .from(snippets)
          .where(
            and(
              eq(snippets.id, id),
              eq(snippets.ownerWorkosUserId, ownerWorkosUserId),
              isNull(snippets.deletedAt),
            ),
          )
          .limit(1)
          .pipe(Effect.orDie);
        return snippet ?? null;
      });

      const create = Effect.fn("SnippetUploads.create")(function* (
        ownerWorkosUserId: string,
        input: CreateStoredSnippetPayload,
      ) {
        const nowDateTime = yield* DateTime.now;
        const now = DateTime.toDateUtc(nowDateTime);
        const uploadHeartbeatExpiresAt = DateTime.toDateUtc(
          DateTime.add(nowDateTime, { milliseconds: UPLOAD_HEARTBEAT_DURATION }),
        );
        const snippet = yield* drizzle.db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [inserted] = yield* tx
                .insert(snippets)
                .values({
                  ...input,
                  ownerWorkosUserId,
                  storageObjectId: null,
                  uploadStatus: "UPLOADING",
                  uploadHeartbeatExpiresAt,
                  deletedAt: null,
                  createdAt: now,
                  updatedAt: now,
                })
                .onConflictDoNothing()
                .returning();
              if (inserted !== undefined) {
                yield* appendSnippetChange(tx, { type: "UPSERT", snippet: inserted });
                return { type: "snippet" as const, snippet: inserted };
              }

              const [existing] = yield* tx
                .select()
                .from(snippets)
                .where(
                  and(
                    eq(snippets.id, input.id),
                    eq(snippets.ownerWorkosUserId, ownerWorkosUserId),
                    isNull(snippets.deletedAt),
                  ),
                )
                .limit(1);
              if (existing === undefined || !sameCreate(existing, input)) {
                return { type: "conflict" as const };
              }
              return { type: "snippet" as const, snippet: existing };
            }),
          )
          .pipe(Effect.orDie);
        if (snippet.type === "conflict") {
          return yield* conflict("Snippet identifier is already used by different content.");
        }
        return toApiSnippet(snippet.snippet);
      });

      const prepare = Effect.fn("SnippetUploads.prepare")(function* (
        ownerWorkosUserId: string,
        input: PrepareSnippetUploadInput,
      ) {
        const snippet = yield* findOwnedSnippet(ownerWorkosUserId, input.id);
        const nowDateTime = yield* DateTime.now;
        const now = DateTime.toDateUtc(nowDateTime);
        if (snippet === null) return yield* notFound();
        if (!hasLiveUploadHeartbeat(snippet, now)) {
          return yield* conflict("Only a live upload can request a provider destination.");
        }

        return yield* storage
          .prepareUpload({
            snippetId: snippet.id,
            storageProvider: snippet.storageProvider,
            fileName: snippet.fileName,
            byteSize: snippet.byteSize,
            contentType: input.mediaType,
            workosUserId: ownerWorkosUserId,
          })
          .pipe(mapStorageErrorsToRpc);
      });

      const heartbeat = Effect.fn("SnippetUploads.heartbeat")(function* (
        ownerWorkosUserId: string,
        id: string,
      ) {
        const current = yield* findOwnedSnippet(ownerWorkosUserId, id);
        const nowDateTime = yield* DateTime.now;
        const now = DateTime.toDateUtc(nowDateTime);
        if (current === null) return yield* notFound();
        if (!hasLiveUploadHeartbeat(current, now)) {
          return yield* conflict("A failed or expired upload cannot be renewed.");
        }
        const expiresAt = DateTime.toDateUtc(
          DateTime.add(nowDateTime, { milliseconds: UPLOAD_HEARTBEAT_DURATION }),
        );
        const [updated] = yield* drizzle.db
          .update(snippets)
          .set({ uploadHeartbeatExpiresAt: expiresAt })
          .where(
            and(
              eq(snippets.id, id),
              eq(snippets.ownerWorkosUserId, ownerWorkosUserId),
              eq(snippets.uploadStatus, "UPLOADING"),
              gt(snippets.uploadHeartbeatExpiresAt, now),
              isNull(snippets.deletedAt),
            ),
          )
          .returning()
          .pipe(Effect.orDie);
        if (updated === undefined) {
          return yield* conflict("Upload status changed before its heartbeat was renewed.");
        }
        return { expiresAt: expiresAt.toISOString() };
      });

      const fail = Effect.fn("SnippetUploads.fail")(function* (
        ownerWorkosUserId: string,
        id: string,
      ) {
        const current = yield* findOwnedSnippet(ownerWorkosUserId, id);
        if (current === null) return yield* notFound();
        if (current.uploadStatus === "FAILED") return toApiSnippet(current);
        if (current.uploadStatus !== "UPLOADING") {
          return yield* conflict("Only an uploading snippet can fail.");
        }
        const nowDateTime = yield* DateTime.now;
        const now = DateTime.toDateUtc(nowDateTime);
        const updated = yield* drizzle.db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [snippet] = yield* tx
                .update(snippets)
                .set({
                  uploadStatus: "FAILED",
                  uploadHeartbeatExpiresAt: null,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(snippets.id, id),
                    eq(snippets.ownerWorkosUserId, ownerWorkosUserId),
                    eq(snippets.uploadStatus, "UPLOADING"),
                    isNull(snippets.deletedAt),
                  ),
                )
                .returning();
              if (snippet !== undefined) {
                yield* appendSnippetChange(tx, { type: "UPSERT", snippet });
              }
              return snippet;
            }),
          )
          .pipe(Effect.orDie);
        if (updated === undefined) {
          const latest = yield* findOwnedSnippet(ownerWorkosUserId, id);
          if (latest?.uploadStatus === "FAILED") return toApiSnippet(latest);
          return yield* conflict("Upload status changed before failure was recorded.");
        }
        return toApiSnippet(updated);
      });

      const retry = Effect.fn("SnippetUploads.retry")(function* (
        ownerWorkosUserId: string,
        id: string,
      ) {
        const current = yield* findOwnedSnippet(ownerWorkosUserId, id);
        const nowDateTime = yield* DateTime.now;
        const now = DateTime.toDateUtc(nowDateTime);
        if (current === null) return yield* notFound();
        if (hasLiveUploadHeartbeat(current, now)) return toApiSnippet(current);
        if (current.uploadStatus !== "FAILED") {
          return yield* conflict("Only a failed upload can be retried.");
        }
        const uploadHeartbeatExpiresAt = DateTime.toDateUtc(
          DateTime.add(nowDateTime, { milliseconds: UPLOAD_HEARTBEAT_DURATION }),
        );
        const updated = yield* drizzle.db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [snippet] = yield* tx
                .update(snippets)
                .set({
                  uploadStatus: "UPLOADING",
                  uploadHeartbeatExpiresAt,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(snippets.id, id),
                    eq(snippets.ownerWorkosUserId, ownerWorkosUserId),
                    eq(snippets.uploadStatus, "FAILED"),
                    isNull(snippets.deletedAt),
                  ),
                )
                .returning();
              if (snippet !== undefined) {
                yield* appendSnippetChange(tx, { type: "UPSERT", snippet });
              }
              return snippet;
            }),
          )
          .pipe(Effect.orDie);
        if (updated === undefined) {
          const latest = yield* findOwnedSnippet(ownerWorkosUserId, id);
          if (latest !== null && hasLiveUploadHeartbeat(latest, now)) return toApiSnippet(latest);
          return yield* conflict("Upload status changed before retry was recorded.");
        }
        return toApiSnippet(updated);
      });

      const complete = Effect.fn("SnippetUploads.complete")(function* (
        ownerWorkosUserId: string,
        input: CompleteSnippetUploadInput,
      ) {
        const current = yield* findOwnedSnippet(ownerWorkosUserId, input.id);
        const now = DateTime.toDateUtc(yield* DateTime.now);
        if (current === null) return yield* notFound();
        if (current.uploadStatus === "UPLOADED") {
          if (current.storageObjectId === input.storageObjectId) return toApiSnippet(current);
          return yield* conflict("Snippet was completed with a different provider object.");
        }
        if (!hasLiveUploadHeartbeat(current, now)) {
          return yield* conflict("Only a live upload can be completed.");
        }
        const updated = yield* drizzle.db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [snippet] = yield* tx
                .update(snippets)
                .set({
                  uploadStatus: "UPLOADED",
                  storageObjectId: input.storageObjectId,
                  uploadHeartbeatExpiresAt: null,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(snippets.id, input.id),
                    eq(snippets.ownerWorkosUserId, ownerWorkosUserId),
                    eq(snippets.uploadStatus, "UPLOADING"),
                    gt(snippets.uploadHeartbeatExpiresAt, now),
                    isNull(snippets.deletedAt),
                  ),
                )
                .returning();
              if (snippet !== undefined) {
                yield* appendSnippetChange(tx, { type: "UPSERT", snippet });
              }
              return snippet;
            }),
          )
          .pipe(Effect.orDie);
        if (updated === undefined) {
          const latest = yield* findOwnedSnippet(ownerWorkosUserId, input.id);
          if (
            latest?.uploadStatus === "UPLOADED" &&
            latest.storageObjectId === input.storageObjectId
          ) {
            return toApiSnippet(latest);
          }
          return yield* conflict("Upload status changed before completion was recorded.");
        }
        return toApiSnippet(updated);
      });

      const expire = Effect.gen(function* () {
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const expired = yield* drizzle.db
          .transaction((tx) =>
            Effect.gen(function* () {
              const candidates = yield* tx
                .select({ id: snippets.id })
                .from(snippets)
                .where(
                  and(
                    eq(snippets.uploadStatus, "UPLOADING"),
                    lte(snippets.uploadHeartbeatExpiresAt, now),
                    isNull(snippets.deletedAt),
                  ),
                )
                .for("update", { skipLocked: true })
                .limit(EXPIRATION_BATCH_SIZE);
              if (candidates.length === 0) return [];

              const updated = yield* tx
                .update(snippets)
                .set({
                  uploadStatus: "FAILED",
                  uploadHeartbeatExpiresAt: null,
                  updatedAt: now,
                })
                .where(
                  and(
                    inArray(
                      snippets.id,
                      candidates.map((candidate) => candidate.id),
                    ),
                    eq(snippets.uploadStatus, "UPLOADING"),
                    lte(snippets.uploadHeartbeatExpiresAt, now),
                    isNull(snippets.deletedAt),
                  ),
                )
                .returning();
              yield* Effect.forEach(
                updated,
                (snippet) => appendSnippetChange(tx, { type: "UPSERT", snippet }),
                { discard: true },
              );
              return updated;
            }),
          )
          .pipe(Effect.orDie);
        return expired.length;
      }).pipe(Effect.withSpan("SnippetUploads.expire"));

      return SnippetUploads.of({ create, prepare, heartbeat, fail, retry, complete, expire });
    }),
  );
}
