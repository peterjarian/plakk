import type { StorageProvider as StorageProviderName } from "@plakk/shared";
import type {
  StorageCleanupAction,
  StorageCleanupRunResult,
  StorageManagementState,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { and, Drizzle, eq, isNull, lte, or, sql } from "@plakk/db";
import { snippets, storageCleanupIntents, type StorageCleanupIntentRow } from "@plakk/db/schema";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";

import { notifySnippetChanges } from "../snippets/SnippetInvalidation.ts";
import { type StorageDeletionError, StorageProvider } from "./StorageProvider.ts";

const CLEANUP_LEASE_MILLIS = 2 * 60 * 1_000;

const newCleanupAttemptId = Effect.fn("StorageLifecycle.newCleanupAttemptId")(function* () {
  const words = yield* Effect.all(
    Array.from({ length: 4 }, () => Random.nextIntBetween(0, 0xffff_ffff)),
  );
  const hex = words.map((word) => word.toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
});

export type StorageCleanupRecord = {
  readonly action: StorageCleanupAction;
  readonly attemptId: string | null;
  readonly lastFailure: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly storageProvider: StorageProviderName;
  readonly totalSnippetCount: number;
  readonly workosUserId: string;
};

export type StorageCleanupSnippet = {
  readonly id: string;
  readonly storageObjectId: string;
  readonly storageProvider: StorageProviderName;
};

export type StorageLifecycleStoreRead = {
  readonly affectedSnippetCount: number;
  readonly cleanup: StorageCleanupRecord | null;
  readonly remainingSnippetCount: number;
};

export type BeginStorageCleanupInput = {
  readonly action: StorageCleanupAction;
  readonly expectedSnippetCount: number;
  readonly storageProvider: StorageProviderName;
  readonly workosUserId: string;
};

export class StorageLifecycleStore extends Context.Service<
  StorageLifecycleStore,
  {
    readonly begin: (input: BeginStorageCleanupInput) => Effect.Effect<StorageCleanupRecord | null>;
    readonly claim: (
      workosUserId: string,
      storageProvider: StorageProviderName,
    ) => Effect.Effect<{
      readonly cleanup: StorageCleanupRecord;
      readonly snippets: ReadonlyArray<StorageCleanupSnippet>;
    } | null>;
    readonly complete: (workosUserId: string, attemptId: string) => Effect.Effect<void>;
    readonly completeSnippet: (
      workosUserId: string,
      attemptId: string,
      snippetId: string,
    ) => Effect.Effect<void>;
    readonly fail: (
      workosUserId: string,
      attemptId: string,
      message: string,
    ) => Effect.Effect<void>;
    readonly get: (
      workosUserId: string,
      storageProvider: StorageProviderName | null,
    ) => Effect.Effect<StorageLifecycleStoreRead>;
    readonly isActive: (workosUserId: string) => Effect.Effect<boolean>;
  }
>()("@plakk/backend/storage/StorageLifecycle/StorageLifecycleStore") {
  static readonly layer = Layer.effect(
    StorageLifecycleStore,
    Effect.gen(function* () {
      const { db } = yield* Drizzle;

      const toRecord = (row: StorageCleanupIntentRow): StorageCleanupRecord => ({
        action: row.action,
        attemptId: row.attemptId,
        lastFailure: row.lastFailure,
        leaseExpiresAt: row.leaseExpiresAt,
        storageProvider: row.storageProvider,
        totalSnippetCount: row.totalSnippetCount,
        workosUserId: row.workosUserId,
      });

      const countSnippets = Effect.fn("StorageLifecycleStore.countSnippets")(function* (
        workosUserId: string,
        storageProvider: StorageProviderName,
      ) {
        const [result] = yield* db
          .select({ count: sql<number>`count(*)::int` })
          .from(snippets)
          .where(
            and(
              eq(snippets.ownerWorkosUserId, workosUserId),
              eq(snippets.storageProvider, storageProvider),
            ),
          )
          .pipe(Effect.orDie);
        return result?.count ?? 0;
      });

      const get = Effect.fn("StorageLifecycleStore.get")(function* (
        workosUserId: string,
        storageProvider: StorageProviderName | null,
      ) {
        const [row] = yield* db
          .select()
          .from(storageCleanupIntents)
          .where(eq(storageCleanupIntents.workosUserId, workosUserId))
          .limit(1)
          .pipe(Effect.orDie);
        const cleanup = row === undefined ? null : toRecord(row);
        const effectiveProvider = cleanup?.storageProvider ?? storageProvider;
        const remainingSnippetCount =
          effectiveProvider === null ? 0 : yield* countSnippets(workosUserId, effectiveProvider);
        return {
          affectedSnippetCount:
            cleanup === null ? remainingSnippetCount : cleanup.totalSnippetCount,
          cleanup,
          remainingSnippetCount: cleanup === null ? 0 : remainingSnippetCount,
        };
      });

      const begin = Effect.fn("StorageLifecycleStore.begin")(function* (
        input: BeginStorageCleanupInput,
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${input.workosUserId}, 0))`,
              );
              const [existing] = yield* tx
                .select()
                .from(storageCleanupIntents)
                .where(eq(storageCleanupIntents.workosUserId, input.workosUserId))
                .limit(1);
              if (existing !== undefined) return toRecord(existing);

              const [count] = yield* tx
                .select({ count: sql<number>`count(*)::int` })
                .from(snippets)
                .where(
                  and(
                    eq(snippets.ownerWorkosUserId, input.workosUserId),
                    eq(snippets.storageProvider, input.storageProvider),
                  ),
                );
              if ((count?.count ?? 0) !== input.expectedSnippetCount) return null;
              const [created] = yield* tx
                .insert(storageCleanupIntents)
                .values({
                  action: input.action,
                  storageProvider: input.storageProvider,
                  totalSnippetCount: input.expectedSnippetCount,
                  workosUserId: input.workosUserId,
                })
                .returning();
              return created === undefined ? null : toRecord(created);
            }),
          )
          .pipe(Effect.orDie);
      });

      const claim = Effect.fn("StorageLifecycleStore.claim")(function* (
        workosUserId: string,
        storageProvider: StorageProviderName,
      ) {
        const now = yield* DateTime.now;
        const attemptId = yield* newCleanupAttemptId();
        const leaseExpiresAt = DateTime.toDateUtc(DateTime.addDuration(now, CLEANUP_LEASE_MILLIS));
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [claimed] = yield* tx
                .update(storageCleanupIntents)
                .set({
                  attemptId,
                  leaseExpiresAt,
                  updatedAt: DateTime.toDateUtc(now),
                })
                .where(
                  and(
                    eq(storageCleanupIntents.workosUserId, workosUserId),
                    eq(storageCleanupIntents.storageProvider, storageProvider),
                    or(
                      isNull(storageCleanupIntents.attemptId),
                      lte(storageCleanupIntents.leaseExpiresAt, DateTime.toDateUtc(now)),
                    ),
                  ),
                )
                .returning();
              if (claimed === undefined) return null;
              const remaining = yield* tx
                .select({
                  id: snippets.id,
                  storageObjectId: snippets.storageObjectId,
                  storageProvider: snippets.storageProvider,
                })
                .from(snippets)
                .where(
                  and(
                    eq(snippets.ownerWorkosUserId, workosUserId),
                    eq(snippets.storageProvider, storageProvider),
                  ),
                )
                .orderBy(snippets.createdAt);
              return { cleanup: toRecord(claimed), snippets: remaining };
            }),
          )
          .pipe(Effect.orDie);
      });

      const completeSnippet = Effect.fn("StorageLifecycleStore.completeSnippet")(function* (
        workosUserId: string,
        attemptId: string,
        snippetId: string,
      ) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [active] = yield* tx
                .select({ attemptId: storageCleanupIntents.attemptId })
                .from(storageCleanupIntents)
                .where(
                  and(
                    eq(storageCleanupIntents.workosUserId, workosUserId),
                    eq(storageCleanupIntents.attemptId, attemptId),
                  ),
                )
                .limit(1);
              if (active === undefined) return;
              const [removed] = yield* tx
                .delete(snippets)
                .where(
                  and(eq(snippets.ownerWorkosUserId, workosUserId), eq(snippets.id, snippetId)),
                )
                .returning({ id: snippets.id });
              if (removed !== undefined) yield* notifySnippetChanges(tx, workosUserId);
            }),
          )
          .pipe(Effect.orDie);
      });

      const fail = Effect.fn("StorageLifecycleStore.fail")(function* (
        workosUserId: string,
        attemptId: string,
        message: string,
      ) {
        yield* db
          .update(storageCleanupIntents)
          .set({
            attemptId: null,
            lastFailure: message,
            leaseExpiresAt: null,
            updatedAt: DateTime.toDateUtc(yield* DateTime.now),
          })
          .where(
            and(
              eq(storageCleanupIntents.workosUserId, workosUserId),
              eq(storageCleanupIntents.attemptId, attemptId),
            ),
          )
          .pipe(Effect.orDie);
      });

      const complete = Effect.fn("StorageLifecycleStore.complete")(function* (
        workosUserId: string,
        attemptId: string,
      ) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(storageCleanupIntents)
                .where(
                  and(
                    eq(storageCleanupIntents.workosUserId, workosUserId),
                    eq(storageCleanupIntents.attemptId, attemptId),
                  ),
                );
              yield* notifySnippetChanges(tx, workosUserId);
            }),
          )
          .pipe(Effect.orDie);
      });

      const isActive = Effect.fn("StorageLifecycleStore.isActive")(function* (
        workosUserId: string,
      ) {
        const [row] = yield* db
          .select({ workosUserId: storageCleanupIntents.workosUserId })
          .from(storageCleanupIntents)
          .where(eq(storageCleanupIntents.workosUserId, workosUserId))
          .limit(1)
          .pipe(Effect.orDie);
        return row !== undefined;
      });

      return StorageLifecycleStore.of({
        begin,
        claim,
        complete,
        completeSnippet,
        fail,
        get,
        isActive,
      });
    }),
  );
}

const conflict = (message: string) => new RpcError({ code: "CONFLICT", message });
const internal = (message: string) => new RpcError({ code: "INTERNAL_SERVER_ERROR", message });

const cleanupFailureMessage = (error: StorageDeletionError): string => {
  switch (error._tag) {
    case "StorageNeedsReauthorizationError":
      return "Reconnect storage before retrying cleanup.";
    case "StorageNotConnectedError":
      return "The storage credential is unavailable. Reconnect it before retrying cleanup.";
    case "StorageCredentialsError":
      return "Storage credentials are temporarily unavailable. Retry cleanup shortly.";
    case "StorageProviderError":
      return `Could not remove remaining ${error.storageProvider} content. Retry cleanup.`;
  }
};

export class StorageLifecycle extends Context.Service<
  StorageLifecycle,
  {
    readonly assertCommandsAllowed: (workosUserId: string) => Effect.Effect<void, RpcError>;
    readonly beginAuthorization: (
      workosUserId: string,
      storageProvider: StorageProviderName,
      returnTo: string,
    ) => Effect.Effect<{ readonly url: string }, RpcError>;
    readonly beginCleanup: (
      input: BeginStorageCleanupInput,
    ) => Effect.Effect<StorageCleanupRunResult, RpcError>;
    readonly getManagementState: (
      workosUserId: string,
    ) => Effect.Effect<StorageManagementState, RpcError>;
    readonly retryCleanup: (
      workosUserId: string,
      storageProvider: StorageProviderName,
    ) => Effect.Effect<StorageCleanupRunResult, RpcError>;
  }
>()("@plakk/backend/storage/StorageLifecycle") {
  static readonly layer = Layer.effect(
    StorageLifecycle,
    Effect.gen(function* () {
      const storage = yield* StorageProvider;
      const store = yield* StorageLifecycleStore;

      const assertCommandsAllowed = Effect.fn("StorageLifecycle.assertCommandsAllowed")(function* (
        workosUserId: string,
      ) {
        if (yield* store.isActive(workosUserId)) {
          return yield* conflict("Storage cleanup is in progress. Retry or finish it first.");
        }
      });

      const beginAuthorization = Effect.fn("StorageLifecycle.beginAuthorization")(function* (
        workosUserId: string,
        storageProvider: StorageProviderName,
        returnTo: string,
      ) {
        yield* assertCommandsAllowed(workosUserId);
        const linkedProvider = yield* storage
          .getLinkedProvider(workosUserId)
          .pipe(Effect.mapError((error) => internal(error.message)));
        if (linkedProvider !== null && linkedProvider !== storageProvider) {
          return yield* conflict(
            "Unlink the current storage provider before choosing another provider.",
          );
        }
        return yield* storage
          .beginAuthorization({ returnTo, storageProvider, workosUserId })
          .pipe(Effect.mapError((error) => internal(error.message)));
      });

      const progress = Effect.fn("StorageLifecycle.progress")(function* (
        workosUserId: string,
        storageProvider: StorageProviderName,
      ) {
        const current = yield* store.get(workosUserId, storageProvider);
        if (current.cleanup === null) {
          return yield* internal("Storage cleanup progress was not found.");
        }
        return {
          action: current.cleanup.action,
          lastFailure: current.cleanup.lastFailure,
          remainingSnippetCount: current.remainingSnippetCount,
          totalSnippetCount: current.cleanup.totalSnippetCount,
        } as const;
      });

      const recordPartial = Effect.fn("StorageLifecycle.recordPartial")(function* (
        cleanup: StorageCleanupRecord,
        message: string,
      ) {
        if (cleanup.attemptId === null) {
          return yield* internal("Storage cleanup attempt was not claimed.");
        }
        yield* store.fail(cleanup.workosUserId, cleanup.attemptId, message);
        return {
          outcome: "PARTIAL",
          progress: yield* progress(cleanup.workosUserId, cleanup.storageProvider),
        } as const;
      });

      const runCleanup = Effect.fn("StorageLifecycle.runCleanup")(function* (
        workosUserId: string,
        storageProvider: StorageProviderName,
      ): Effect.fn.Return<StorageCleanupRunResult, RpcError> {
        const claimed = yield* store.claim(workosUserId, storageProvider);
        if (claimed === null) {
          return yield* conflict("Storage cleanup is already running or no longer available.");
        }
        const { cleanup } = claimed;
        const attemptId = cleanup.attemptId;
        if (attemptId === null) {
          return yield* internal("Storage cleanup attempt was not claimed.");
        }
        for (const snippet of claimed.snippets) {
          const deletion = yield* storage
            .deleteObject({
              storageObjectId: snippet.storageObjectId,
              storageProvider: snippet.storageProvider,
              workosUserId,
            })
            .pipe(Effect.result);
          if (deletion._tag === "Failure") {
            return yield* recordPartial(cleanup, cleanupFailureMessage(deletion.failure));
          }
          yield* store.completeSnippet(workosUserId, attemptId, snippet.id);
        }

        const disconnected = yield* storage
          .disconnect({ storageProvider, workosUserId })
          .pipe(Effect.result);
        if (disconnected._tag === "Failure") {
          return yield* recordPartial(
            cleanup,
            "Provider content is removed, but credential disconnection still needs Retry.",
          );
        }
        yield* store.complete(workosUserId, attemptId);
        return { action: cleanup.action, outcome: "COMPLETED" };
      });

      const beginCleanup = Effect.fn("StorageLifecycle.beginCleanup")(function* (
        input: BeginStorageCleanupInput,
      ) {
        const linkedProvider = yield* storage
          .getLinkedProvider(input.workosUserId)
          .pipe(Effect.mapError((error) => internal(error.message)));
        if (linkedProvider !== input.storageProvider) {
          return yield* conflict("The selected storage provider is not linked to this account.");
        }
        const cleanup = yield* store.begin(input);
        if (
          cleanup === null ||
          cleanup.storageProvider !== input.storageProvider ||
          cleanup.action !== input.action
        ) {
          return yield* conflict(
            "The affected Snippet count or cleanup action changed. Review it before continuing.",
          );
        }
        return yield* runCleanup(input.workosUserId, input.storageProvider);
      });

      const retryCleanup = Effect.fn("StorageLifecycle.retryCleanup")(function* (
        workosUserId: string,
        storageProvider: StorageProviderName,
      ) {
        const current = yield* store.get(workosUserId, storageProvider);
        if (current.cleanup?.storageProvider !== storageProvider) {
          return yield* conflict("No matching storage cleanup is available to retry.");
        }
        return yield* runCleanup(workosUserId, storageProvider);
      });

      const getManagementState = Effect.fn("StorageLifecycle.getManagementState")(function* (
        workosUserId: string,
      ) {
        const linkedProvider = yield* storage
          .getLinkedProvider(workosUserId)
          .pipe(Effect.mapError((error) => internal(error.message)));
        const stored = yield* store.get(workosUserId, linkedProvider);
        const effectiveProvider = stored.cleanup?.storageProvider ?? linkedProvider;
        const providerStatus =
          effectiveProvider === null
            ? ({
                externalDestinationUrl: null,
                status: "NOT_CONNECTED",
                storageProvider: null,
              } as const)
            : yield* storage
                .getStatus({ storageProvider: effectiveProvider, workosUserId })
                .pipe(Effect.mapError((error) => internal(error.message)));
        return {
          affectedSnippetCount: stored.affectedSnippetCount,
          cleanup:
            stored.cleanup === null
              ? null
              : {
                  action: stored.cleanup.action,
                  lastFailure: stored.cleanup.lastFailure,
                  remainingSnippetCount: stored.remainingSnippetCount,
                  totalSnippetCount: stored.cleanup.totalSnippetCount,
                },
          connectionStatus: providerStatus.status,
          externalDestinationUrl: providerStatus.externalDestinationUrl,
          storageProvider: effectiveProvider,
        };
      });

      return StorageLifecycle.of({
        assertCommandsAllowed,
        beginAuthorization,
        beginCleanup,
        getManagementState,
        retryCleanup,
      });
    }),
  );
}
