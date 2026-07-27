import type { StorageProvider as StorageProviderName } from "@plakk/shared";
import type {
  StorageCleanupAction,
  StorageCleanupRunResult,
  StorageManagementState,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { and, Drizzle, eq, isNull, lte, or, sql } from "@plakk/db";
import {
  snippets,
  storageAuthorizationIntents,
  storageCleanupIntents,
  type StorageCleanupIntentRow,
} from "@plakk/db/schema";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";

import { notifySnippetChanges } from "../snippets/SnippetInvalidation.ts";
import { type StorageDeletionError, StorageProvider } from "./StorageProvider.ts";

const CLEANUP_LEASE_MILLIS = 2 * 60 * 1_000;
const AUTHORIZATION_RESERVATION_MILLIS = 15 * 60 * 1_000;

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

type StorageLifecycleTransaction = Parameters<
  Parameters<import("@plakk/db").DrizzleService["db"]["transaction"]>[0]
>[0];

const toCleanupRecord = (row: StorageCleanupIntentRow): StorageCleanupRecord => ({
  action: row.action,
  attemptId: row.attemptId,
  lastFailure: row.lastFailure,
  leaseExpiresAt: row.leaseExpiresAt,
  storageProvider: row.storageProvider,
  totalSnippetCount: row.totalSnippetCount,
  workosUserId: row.workosUserId,
});

export const lockStorageLifecycleState = Effect.fn("StorageLifecycle.lockState")(function* (
  tx: StorageLifecycleTransaction,
  workosUserId: string,
) {
  yield* tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workosUserId}, 0))`);
  const [row] = yield* tx
    .select()
    .from(storageCleanupIntents)
    .where(eq(storageCleanupIntents.workosUserId, workosUserId))
    .limit(1);
  return row === undefined ? null : toCleanupRecord(row);
});

const activeAuthorizationProvider = Effect.fn("StorageLifecycle.activeAuthorizationProvider")(
  function* (tx: StorageLifecycleTransaction, workosUserId: string, now: Date) {
    const [authorization] = yield* tx
      .select({
        expiresAt: storageAuthorizationIntents.expiresAt,
        storageProvider: storageAuthorizationIntents.storageProvider,
      })
      .from(storageAuthorizationIntents)
      .where(eq(storageAuthorizationIntents.workosUserId, workosUserId))
      .limit(1);
    if (authorization === undefined) return null;
    if (authorization.expiresAt > now) return authorization.storageProvider;
    yield* tx
      .delete(storageAuthorizationIntents)
      .where(eq(storageAuthorizationIntents.workosUserId, workosUserId));
    return null;
  },
);

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
    readonly clearAuthorization: (
      workosUserId: string,
      storageProvider: StorageProviderName,
    ) => Effect.Effect<void>;
    readonly complete: (workosUserId: string, attemptId: string) => Effect.Effect<boolean>;
    readonly completeSnippet: (
      workosUserId: string,
      attemptId: string,
      snippetId: string,
    ) => Effect.Effect<boolean>;
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
    readonly readyToDisconnect: (workosUserId: string, attemptId: string) => Effect.Effect<boolean>;
    readonly renew: (workosUserId: string, attemptId: string) => Effect.Effect<boolean>;
    readonly reserveAuthorization: (
      workosUserId: string,
      storageProvider: StorageProviderName,
    ) => Effect.Effect<{
      readonly acquired: boolean;
      readonly storageProvider: StorageProviderName;
    } | null>;
  }
>()("@plakk/backend/storage/StorageLifecycle/StorageLifecycleStore") {
  static readonly layer = Layer.effect(
    StorageLifecycleStore,
    Effect.gen(function* () {
      const { db } = yield* Drizzle;

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
        const cleanup = row === undefined ? null : toCleanupRecord(row);
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
        const now = DateTime.toDateUtc(yield* DateTime.now);
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const existing = yield* lockStorageLifecycleState(tx, input.workosUserId);
              if ((yield* activeAuthorizationProvider(tx, input.workosUserId, now)) !== null) {
                return null;
              }
              if (existing !== null) return existing;

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
              if (created !== undefined) yield* notifySnippetChanges(tx, input.workosUserId);
              return created === undefined ? null : toCleanupRecord(created);
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
              const current = yield* lockStorageLifecycleState(tx, workosUserId);
              if (current?.storageProvider !== storageProvider) return null;
              if (
                (yield* activeAuthorizationProvider(tx, workosUserId, DateTime.toDateUtc(now))) !==
                null
              ) {
                return null;
              }
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
              return { cleanup: toCleanupRecord(claimed), snippets: remaining };
            }),
          )
          .pipe(Effect.orDie);
      });

      const completeSnippet = Effect.fn("StorageLifecycleStore.completeSnippet")(function* (
        workosUserId: string,
        attemptId: string,
        snippetId: string,
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const active = yield* lockStorageLifecycleState(tx, workosUserId);
              if (active?.attemptId !== attemptId) return false;
              const [removed] = yield* tx
                .delete(snippets)
                .where(
                  and(eq(snippets.ownerWorkosUserId, workosUserId), eq(snippets.id, snippetId)),
                )
                .returning({ id: snippets.id });
              if (removed !== undefined) yield* notifySnippetChanges(tx, workosUserId);
              return true;
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
          .transaction((tx) =>
            Effect.gen(function* () {
              const updated = yield* tx
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
                .returning({ workosUserId: storageCleanupIntents.workosUserId });
              if (updated.length > 0) yield* notifySnippetChanges(tx, workosUserId);
            }),
          )
          .pipe(Effect.orDie);
      });

      const readyToDisconnect = Effect.fn("StorageLifecycleStore.readyToDisconnect")(function* (
        workosUserId: string,
        attemptId: string,
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const cleanup = yield* lockStorageLifecycleState(tx, workosUserId);
              if (cleanup?.attemptId !== attemptId) return false;
              const [remaining] = yield* tx
                .select({ count: sql<number>`count(*)::int` })
                .from(snippets)
                .where(
                  and(
                    eq(snippets.ownerWorkosUserId, workosUserId),
                    eq(snippets.storageProvider, cleanup.storageProvider),
                  ),
                );
              return (remaining?.count ?? 0) === 0;
            }),
          )
          .pipe(Effect.orDie);
      });

      const renew = Effect.fn("StorageLifecycleStore.renew")(function* (
        workosUserId: string,
        attemptId: string,
      ) {
        const now = yield* DateTime.now;
        const leaseExpiresAt = DateTime.toDateUtc(DateTime.addDuration(now, CLEANUP_LEASE_MILLIS));
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const cleanup = yield* lockStorageLifecycleState(tx, workosUserId);
              if (cleanup?.attemptId !== attemptId) return false;
              const renewed = yield* tx
                .update(storageCleanupIntents)
                .set({
                  leaseExpiresAt,
                  updatedAt: DateTime.toDateUtc(now),
                })
                .where(
                  and(
                    eq(storageCleanupIntents.workosUserId, workosUserId),
                    eq(storageCleanupIntents.attemptId, attemptId),
                  ),
                )
                .returning({ workosUserId: storageCleanupIntents.workosUserId });
              return renewed.length > 0;
            }),
          )
          .pipe(Effect.orDie);
      });

      const complete = Effect.fn("StorageLifecycleStore.complete")(function* (
        workosUserId: string,
        attemptId: string,
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const removed = yield* tx
                .delete(storageCleanupIntents)
                .where(
                  and(
                    eq(storageCleanupIntents.workosUserId, workosUserId),
                    eq(storageCleanupIntents.attemptId, attemptId),
                  ),
                )
                .returning({ workosUserId: storageCleanupIntents.workosUserId });
              if (removed.length === 0) return false;
              yield* notifySnippetChanges(tx, workosUserId);
              return true;
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

      const reserveAuthorization = Effect.fn("StorageLifecycleStore.reserveAuthorization")(
        function* (workosUserId: string, storageProvider: StorageProviderName) {
          const now = yield* DateTime.now;
          const expiresAt = DateTime.toDateUtc(
            DateTime.addDuration(now, AUTHORIZATION_RESERVATION_MILLIS),
          );
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const cleanup = yield* lockStorageLifecycleState(tx, workosUserId);
                if (cleanup !== null && cleanup.storageProvider !== storageProvider) return null;
                const [existing] = yield* tx
                  .select({
                    expiresAt: storageAuthorizationIntents.expiresAt,
                    storageProvider: storageAuthorizationIntents.storageProvider,
                  })
                  .from(storageAuthorizationIntents)
                  .where(eq(storageAuthorizationIntents.workosUserId, workosUserId))
                  .limit(1);
                if (existing !== undefined && existing.expiresAt > DateTime.toDateUtc(now)) {
                  return { acquired: false, storageProvider: existing.storageProvider };
                }
                if (existing !== undefined) {
                  const [renewed] = yield* tx
                    .update(storageAuthorizationIntents)
                    .set({
                      expiresAt,
                      storageProvider,
                      updatedAt: DateTime.toDateUtc(now),
                    })
                    .where(eq(storageAuthorizationIntents.workosUserId, workosUserId))
                    .returning({
                      storageProvider: storageAuthorizationIntents.storageProvider,
                    });
                  return renewed === undefined
                    ? null
                    : { acquired: true, storageProvider: renewed.storageProvider };
                }
                const [created] = yield* tx
                  .insert(storageAuthorizationIntents)
                  .values({ expiresAt, storageProvider, workosUserId })
                  .returning({ storageProvider: storageAuthorizationIntents.storageProvider });
                return created === undefined
                  ? null
                  : { acquired: true, storageProvider: created.storageProvider };
              }),
            )
            .pipe(Effect.orDie);
        },
      );

      const clearAuthorization = Effect.fn("StorageLifecycleStore.clearAuthorization")(function* (
        workosUserId: string,
        storageProvider: StorageProviderName,
      ) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* lockStorageLifecycleState(tx, workosUserId);
              yield* tx
                .delete(storageAuthorizationIntents)
                .where(
                  and(
                    eq(storageAuthorizationIntents.workosUserId, workosUserId),
                    eq(storageAuthorizationIntents.storageProvider, storageProvider),
                  ),
                );
            }),
          )
          .pipe(Effect.orDie);
      });

      return StorageLifecycleStore.of({
        begin,
        claim,
        clearAuthorization,
        complete,
        completeSnippet,
        fail,
        get,
        isActive,
        readyToDisconnect,
        renew,
        reserveAuthorization,
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
    readonly getProviderStatus: (
      workosUserId: string,
      storageProvider: StorageProviderName,
      consumeAuthorization: boolean,
    ) => Effect.Effect<import("@plakk/shared/PlakkApi").StorageProviderStatus, RpcError>;
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
        const current = yield* store.get(workosUserId, null);
        if (current.cleanup !== null && current.cleanup.storageProvider !== storageProvider) {
          return yield* conflict("Storage cleanup is in progress for another provider.");
        }
        const linkedProvider = yield* storage
          .getLinkedProvider(workosUserId)
          .pipe(Effect.mapError((error) => internal(error.message)));
        if (linkedProvider !== null && linkedProvider !== storageProvider) {
          return yield* conflict(
            "Unlink the current storage provider before choosing another provider.",
          );
        }
        const reservation = yield* store.reserveAuthorization(workosUserId, storageProvider);
        if (reservation === null) {
          return yield* conflict("Storage cleanup is in progress for another provider.");
        }
        if (reservation.storageProvider !== storageProvider) {
          return yield* conflict("Another storage provider authorization is already in progress.");
        }
        if (!reservation.acquired) {
          return yield* conflict(
            "This storage provider authorization is already in progress. Finish it or retry after it expires.",
          );
        }
        const authorization = yield* storage
          .beginAuthorization({ returnTo, storageProvider, workosUserId })
          .pipe(Effect.result);
        if (authorization._tag === "Failure") {
          yield* store.clearAuthorization(workosUserId, storageProvider);
          return yield* internal(authorization.failure.message);
        }
        return authorization.success;
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
          if (!(yield* store.renew(workosUserId, attemptId))) {
            return yield* conflict(
              "Storage cleanup was superseded by another Retry. Refresh its progress.",
            );
          }
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
          if (!(yield* store.completeSnippet(workosUserId, attemptId, snippet.id))) {
            return yield* conflict(
              "Storage cleanup was superseded by another Retry. Refresh its progress.",
            );
          }
        }

        if (!(yield* store.readyToDisconnect(workosUserId, attemptId))) {
          return yield* conflict(
            "Storage cleanup changed before credential disconnection. Refresh its progress.",
          );
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
        if (!(yield* store.complete(workosUserId, attemptId))) {
          return yield* conflict(
            "Storage cleanup was completed by another Retry. Refresh the account state.",
          );
        }
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
          cleanup.action !== input.action ||
          cleanup.totalSnippetCount !== input.expectedSnippetCount
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
        if (effectiveProvider !== null && providerStatus.status === "CONNECTED") {
          yield* store.clearAuthorization(workosUserId, effectiveProvider);
        }
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

      const getProviderStatus = Effect.fn("StorageLifecycle.getProviderStatus")(function* (
        workosUserId: string,
        storageProvider: StorageProviderName,
        consumeAuthorization: boolean,
      ) {
        const status = yield* storage
          .getStatus({ storageProvider, workosUserId })
          .pipe(Effect.mapError((error) => internal(error.message)));
        if (consumeAuthorization || status.status === "CONNECTED") {
          yield* store.clearAuthorization(workosUserId, storageProvider);
        }
        return status;
      });

      return StorageLifecycle.of({
        assertCommandsAllowed,
        beginAuthorization,
        beginCleanup,
        getManagementState,
        getProviderStatus,
        retryCleanup,
      });
    }),
  );
}
