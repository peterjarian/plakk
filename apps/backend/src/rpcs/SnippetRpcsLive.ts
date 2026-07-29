import {
  and,
  desc,
  Drizzle,
  eq,
  PostgresNotifications,
  type PostgresNotificationEvent,
  sql,
  type DrizzleService,
} from "@plakk/db";
import { snippets, type SnippetRow } from "@plakk/db/schema";
import {
  CurrentUser,
  SNIPPET_INVALIDATION_KEEP_ALIVE,
  SNIPPETS_CHANGED,
  type ApiSnippet,
  type PrepareSnippetUploadPayload,
  type PublishSnippetPayload,
  type SnippetInvalidationEvent,
  SnippetRpcs,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { type StorageDownloadError, StorageProvider } from "../storage/StorageProvider.ts";

const SNIPPET_INVALIDATION_CHANNEL = "plakk_snippet_invalidations";

const notifySnippetChanges = Effect.fn("notifySnippetChanges")(function* (
  db: Pick<DrizzleService["db"], "execute">,
  ownerWorkosUserId: string,
) {
  yield* db.execute(sql`select pg_notify(${SNIPPET_INVALIDATION_CHANNEL}, ${ownerWorkosUserId})`);
});

const reconnectSnippetNotifications = <E>(
  listen: () => Stream.Stream<PostgresNotificationEvent, E>,
) =>
  Stream.suspend(() => {
    let attempts = 0;
    return Stream.suspend(() => {
      attempts += 1;
      return listen().pipe(Stream.filter((event) => event._tag !== "Connected" || attempts > 1));
    }).pipe(
      Stream.tapError((error) =>
        Effect.logWarning("PostgreSQL notification listener disconnected", { error }),
      ),
      Stream.retry(Schedule.spaced("1 second")),
    );
  });

const snippetInvalidationStream = <E>(
  notifications: Stream.Stream<PostgresNotificationEvent, E>,
  ownerWorkosUserId: string,
): Stream.Stream<typeof SNIPPETS_CHANGED, E> =>
  Stream.merge(
    Stream.succeed(SNIPPETS_CHANGED),
    notifications.pipe(
      Stream.filter((event) => event._tag === "Connected" || event.payload === ownerWorkosUserId),
      Stream.map(() => SNIPPETS_CHANGED),
    ),
    { haltStrategy: "both" },
  );

const toApiSnippet = (snippet: SnippetRow): ApiSnippet => ({
  id: snippet.id,
  fileName: snippet.fileName,
  byteSize: snippet.byteSize,
  storageProvider: snippet.storageProvider,
  storageObjectId: snippet.storageObjectId,
  createdAt: snippet.createdAt.toISOString(),
  updatedAt: snippet.updatedAt.toISOString(),
});

const storageErrorToRpc = (error: StorageDownloadError): RpcError => {
  switch (error._tag) {
    case "StorageDownloadRejectedError":
      return new RpcError({
        code: "INTERNAL_SERVER_ERROR",
        message: error.message,
        retryable: error.status === 408 || error.status === 429 || error.status >= 500,
      });
    case "StorageObjectNotFoundError":
      return new RpcError({ code: "NOT_FOUND", message: error.message });
    case "StorageNotConnectedError":
    case "StorageNeedsReauthorizationError":
      return new RpcError({ code: "FORBIDDEN", message: error.message });
    case "StorageCredentialsError":
      return new RpcError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
    case "StorageProviderError":
      return new RpcError({
        code: "INTERNAL_SERVER_ERROR",
        message: `${error.storageProvider}: ${error.message}`,
        ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
      });
  }
};

const mapStorageErrorsToRpc = <A, R>(
  effect: Effect.Effect<A, StorageDownloadError, R>,
): Effect.Effect<A, RpcError, R> => effect.pipe(Effect.mapError(storageErrorToRpc));

const samePublication = (snippet: SnippetRow, input: PublishSnippetPayload) =>
  snippet.id === input.id &&
  snippet.fileName === input.fileName &&
  snippet.byteSize === input.byteSize &&
  snippet.storageProvider === input.storageProvider &&
  snippet.storageObjectId === input.storageObjectId;

const prepareSnippetUpload = Effect.fn("SnippetRpcs.prepareUpload")(function* (
  storage: StorageProvider["Service"],
  ownerWorkosUserId: string,
  input: PrepareSnippetUploadPayload,
) {
  return yield* storage
    .prepareUpload({
      snippetId: input.id,
      storageProvider: input.storageProvider,
      fileName: input.fileName,
      byteSize: input.byteSize,
      contentType: input.mediaType,
      workosUserId: ownerWorkosUserId,
    })
    .pipe(mapStorageErrorsToRpc);
});

const publishSnippet = Effect.fn("SnippetRpcs.publish")(function* (
  drizzle: DrizzleService,
  ownerWorkosUserId: string,
  input: PublishSnippetPayload,
) {
  const now = DateTime.toDateUtc(yield* DateTime.now);
  const result = yield* drizzle.db
    .transaction((tx) =>
      Effect.gen(function* () {
        const [inserted] = yield* tx
          .insert(snippets)
          .values({
            ...input,
            ownerWorkosUserId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted !== undefined) {
          yield* notifySnippetChanges(tx, ownerWorkosUserId);
          return { type: "snippet" as const, snippet: inserted };
        }

        const [existing] = yield* tx
          .select()
          .from(snippets)
          .where(and(eq(snippets.id, input.id), eq(snippets.ownerWorkosUserId, ownerWorkosUserId)))
          .limit(1);
        if (existing === undefined || !samePublication(existing, input)) {
          return { type: "conflict" as const };
        }
        return { type: "snippet" as const, snippet: existing };
      }),
    )
    .pipe(Effect.orDie);

  if (result.type === "conflict") {
    return yield* new RpcError({
      code: "CONFLICT",
      message: "Snippet identifier is already used by different content.",
    });
  }
  return toApiSnippet(result.snippet);
});

const getSnippetSnapshot = Effect.fn("SnippetRpcs.getSnapshot")(function* (
  drizzle: DrizzleService,
  ownerWorkosUserId: string,
) {
  const rows = yield* drizzle.db
    .select()
    .from(snippets)
    .where(eq(snippets.ownerWorkosUserId, ownerWorkosUserId))
    .orderBy(desc(snippets.createdAt))
    .pipe(Effect.orDie);

  yield* Effect.annotateCurrentSpan({ itemCount: rows.length });
  yield* Effect.logInfo("Read complete Snippet snapshot", { itemCount: rows.length });
  return rows.map(toApiSnippet);
});

const downloadSnippetContent = Effect.fn("SnippetRpcs.downloadContent")(function* (
  drizzle: DrizzleService,
  storage: StorageProvider["Service"],
  ownerWorkosUserId: string,
  snippetId: string,
) {
  const [snippet] = yield* drizzle.db
    .select()
    .from(snippets)
    .where(and(eq(snippets.id, snippetId), eq(snippets.ownerWorkosUserId, ownerWorkosUserId)))
    .limit(1)
    .pipe(Effect.orDie);

  if (snippet === undefined) {
    return yield* new RpcError({
      code: "NOT_FOUND",
      message: "Uploaded snippet was not found.",
    });
  }

  return storage
    .downloadStream({
      storageProvider: snippet.storageProvider,
      storageObjectId: snippet.storageObjectId,
      expectedByteSize: snippet.byteSize,
      workosUserId: ownerWorkosUserId,
    })
    .pipe(Stream.mapError(storageErrorToRpc));
});

const deleteSnippet = Effect.fn("SnippetRpcs.delete")(function* (
  drizzle: DrizzleService,
  storage: StorageProvider["Service"],
  ownerWorkosUserId: string,
  snippetId: string,
) {
  const deleted = yield* drizzle.db
    .transaction((tx) =>
      Effect.gen(function* () {
        const [removed] = yield* tx
          .delete(snippets)
          .where(and(eq(snippets.id, snippetId), eq(snippets.ownerWorkosUserId, ownerWorkosUserId)))
          .returning();
        if (removed !== undefined) yield* notifySnippetChanges(tx, ownerWorkosUserId);
        return removed;
      }),
    )
    .pipe(Effect.orDie);
  if (deleted === undefined) return;

  yield* storage
    .deleteObject({
      storageProvider: deleted.storageProvider,
      storageObjectId: deleted.storageObjectId,
      workosUserId: deleted.ownerWorkosUserId,
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not delete orphaned provider content", {
          cause,
          snippetId: deleted.id,
          storageProvider: deleted.storageProvider,
        }),
      ),
    );
});

const snippetInvalidationRpcStream = <E>(changes: Stream.Stream<SnippetInvalidationEvent, E>) =>
  Stream.merge(
    changes,
    Stream.fromSchedule(Schedule.spaced("15 seconds")).pipe(
      Stream.map(() => SNIPPET_INVALIDATION_KEEP_ALIVE),
    ),
  );

export const SnippetRpcsLive = Effect.gen(function* () {
  const postgresNotifications = yield* PostgresNotifications;
  const notifications = yield* reconnectSnippetNotifications(() =>
    postgresNotifications.listen(SNIPPET_INVALIDATION_CHANNEL),
  ).pipe(Stream.share({ capacity: "unbounded" }));

  return SnippetRpcs.of({
    PrepareSnippetUpload: Effect.fn("rpc.PrepareSnippetUpload")(function* (input) {
      const storage = yield* StorageProvider;
      const currentUser = yield* CurrentUser;
      return yield* prepareSnippetUpload(storage, currentUser.id, input).pipe(
        Effect.annotateSpans({ id: input.id }),
      );
    }),
    PublishSnippet: Effect.fn("rpc.PublishSnippet")(function* (input) {
      const drizzle = yield* Drizzle;
      const currentUser = yield* CurrentUser;
      return yield* publishSnippet(drizzle, currentUser.id, input).pipe(
        Effect.annotateSpans({ id: input.id }),
      );
    }),
    GetSnippetSnapshot: Effect.fn("rpc.GetSnippetSnapshot")(function* () {
      const drizzle = yield* Drizzle;
      const currentUser = yield* CurrentUser;
      return yield* getSnippetSnapshot(drizzle, currentUser.id);
    }),
    WatchSnippetInvalidations: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          yield* Effect.logInfo("Snippet invalidation stream connected", {
            ownerWorkosUserId: currentUser.id,
          });
          return snippetInvalidationRpcStream(
            snippetInvalidationStream(notifications, currentUser.id),
          ).pipe(
            Stream.tapError((cause) =>
              Effect.logError("Snippet invalidation stream failed", {
                cause,
                ownerWorkosUserId: currentUser.id,
              }),
            ),
            Stream.mapError(
              () =>
                new RpcError({
                  code: "INTERNAL_SERVER_ERROR",
                  message: "Live snippet updates are unavailable.",
                }),
            ),
          );
        }),
      ),
    DownloadSnippetContent: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const drizzle = yield* Drizzle;
          const storage = yield* StorageProvider;
          const currentUser = yield* CurrentUser;
          return yield* downloadSnippetContent(drizzle, storage, currentUser.id, input.id);
        }).pipe(Effect.annotateSpans({ id: input.id })),
      ),
    DeleteSnippet: Effect.fn("rpc.DeleteSnippet")(function* (input) {
      const drizzle = yield* Drizzle;
      const storage = yield* StorageProvider;
      const currentUser = yield* CurrentUser;

      yield* Effect.logInfo("Deleting snippet", { id: input.id });
      return yield* deleteSnippet(drizzle, storage, currentUser.id, input.id).pipe(
        Effect.annotateSpans({ id: input.id }),
      );
    }),
  });
});
