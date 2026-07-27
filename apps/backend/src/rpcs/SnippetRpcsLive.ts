import { isSupportedProviderUploadTarget } from "@plakk/shared";
import {
  and,
  desc,
  Drizzle,
  eq,
  PostgresNotifications,
  type PostgresNotificationEvent,
  type DrizzleService,
} from "@plakk/db";
import { snippets, type SnippetRow } from "@plakk/db/schema";
import {
  AuthenticatedRpcRequest,
  CurrentUser,
  SNIPPET_INVALIDATION_KEEP_ALIVE,
  SNIPPETS_CHANGED,
  WEB_SNIPPET_CONTENT_MAX_BYTES,
  type ApiSnippet,
  type PrepareSnippetUploadPayload,
  type PublishSnippetPayload,
  type SnippetInvalidationEvent,
  SnippetRpcs,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { AccountCapability } from "../account/AccountCapability.ts";
import {
  notifySnippetChanges,
  SNIPPET_INVALIDATION_CHANNEL,
} from "../snippets/SnippetInvalidation.ts";
import { lockStorageLifecycleState } from "../storage/StorageLifecycle.ts";
import { type StorageDownloadError, StorageProvider } from "../storage/StorageProvider.ts";
import { configuredWebOrigin as validateConfiguredWebOrigin } from "../WebOrigin.ts";
import { telemetryErrorAttributes } from "../telemetry/TelemetrySanitization.ts";

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
        Effect.logWarning(
          "PostgreSQL notification listener disconnected",
          telemetryErrorAttributes(error),
        ),
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

const mapStorageErrorsToRpc = <A, R>(
  effect: Effect.Effect<A, StorageDownloadError, R>,
): Effect.Effect<A, RpcError, R> =>
  effect.pipe(
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

const snippetUploadRequestKind = Effect.fn("SnippetRpcs.snippetUploadRequestKind")(function* (
  requestOrigin: string | null,
) {
  if (requestOrigin === null || requestOrigin === "plakk-app://renderer") {
    return "DESKTOP" as const;
  }
  const { configuredWebOrigin, nodeEnv } = yield* Effect.all({
    configuredWebOrigin: Config.string("PLAKK_WEB_ORIGIN"),
    nodeEnv: Config.string("NODE_ENV").pipe(Config.withDefault("development")),
  }).pipe(Effect.orDie);
  const webOrigin = yield* Effect.sync(() =>
    validateConfiguredWebOrigin(configuredWebOrigin, nodeEnv === "production"),
  ).pipe(Effect.orDie);
  if (requestOrigin !== webOrigin) {
    return yield* new RpcError({
      code: "FORBIDDEN",
      message: "Web upload preparation is unavailable from this origin.",
    });
  }
  return "WEB" as const;
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
        if ((yield* lockStorageLifecycleState(tx, ownerWorkosUserId)) !== null) {
          return { type: "cleanup" as const };
        }
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
  if (result.type === "cleanup") {
    return yield* new RpcError({
      code: "CONFLICT",
      message: "Storage cleanup is in progress. Publishing this Snippet was rejected.",
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

const loadAuthorizedSnippet = Effect.fn("SnippetRpcs.loadAuthorizedSnippet")(function* (
  drizzle: DrizzleService,
  capability: AccountCapability["Service"],
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

  yield* capability.authorizeProductCommand(ownerWorkosUserId, snippet.storageProvider);
  return snippet;
});

const prepareSnippetDownload = Effect.fn("SnippetRpcs.prepareDownload")(function* (
  drizzle: DrizzleService,
  capability: AccountCapability["Service"],
  storage: StorageProvider["Service"],
  ownerWorkosUserId: string,
  snippetId: string,
) {
  const snippet = yield* loadAuthorizedSnippet(drizzle, capability, ownerWorkosUserId, snippetId);
  const url = yield* storage
    .getDownloadUrl({
      storageProvider: snippet.storageProvider,
      storageObjectId: snippet.storageObjectId,
      workosUserId: ownerWorkosUserId,
    })
    .pipe(mapStorageErrorsToRpc);

  return {
    storageProvider: snippet.storageProvider,
    fileName: snippet.fileName,
    byteSize: snippet.byteSize,
    // Provider credentials remain backend-owned. The empty collection preserves
    // compatibility with Desktop clients that predate signed browser downloads.
    download: { url, headers: [] },
  };
});

const getSnippetContent = Effect.fn("SnippetRpcs.getContent")(function* (
  drizzle: DrizzleService,
  capability: AccountCapability["Service"],
  storage: StorageProvider["Service"],
  ownerWorkosUserId: string,
  snippetId: string,
) {
  const snippet = yield* loadAuthorizedSnippet(drizzle, capability, ownerWorkosUserId, snippetId);
  if (snippet.byteSize > WEB_SNIPPET_CONTENT_MAX_BYTES) {
    return yield* new RpcError({
      code: "FORBIDDEN",
      message: "This snippet is too large for browser Copy or Open. Download it instead.",
    });
  }

  const content = yield* storage
    .downloadObject({
      storageProvider: snippet.storageProvider,
      storageObjectId: snippet.storageObjectId,
      expectedByteSize: snippet.byteSize,
      workosUserId: ownerWorkosUserId,
    })
    .pipe(mapStorageErrorsToRpc);
  if (content.byteLength !== snippet.byteSize) {
    return yield* new RpcError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Stored object size does not match snippet metadata.",
    });
  }
  return {
    storageProvider: snippet.storageProvider,
    fileName: snippet.fileName,
    byteSize: snippet.byteSize,
    content,
  };
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
        if ((yield* lockStorageLifecycleState(tx, ownerWorkosUserId)) !== null) {
          return { type: "cleanup" as const };
        }
        const [removed] = yield* tx
          .delete(snippets)
          .where(and(eq(snippets.id, snippetId), eq(snippets.ownerWorkosUserId, ownerWorkosUserId)))
          .returning();
        if (removed !== undefined) yield* notifySnippetChanges(tx, ownerWorkosUserId);
        return { type: "deleted" as const, snippet: removed };
      }),
    )
    .pipe(Effect.orDie);
  if (deleted.type === "cleanup") {
    return yield* new RpcError({
      code: "CONFLICT",
      message: "Storage cleanup is in progress. Deleting this Snippet was rejected.",
    });
  }
  if (deleted.snippet === undefined) return;

  yield* storage
    .deleteObject({
      storageProvider: deleted.snippet.storageProvider,
      storageObjectId: deleted.snippet.storageObjectId,
      workosUserId: deleted.snippet.ownerWorkosUserId,
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not delete orphaned provider content", {
          ...telemetryErrorAttributes(Cause.squash(cause)),
          snippetId: deleted.snippet.id,
          storageProvider: deleted.snippet.storageProvider,
        }),
      ),
      Effect.forkDetach({ startImmediately: true }),
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
      const capability = yield* AccountCapability;
      const request = yield* AuthenticatedRpcRequest;
      const storage = yield* StorageProvider;
      const currentUser = yield* CurrentUser;
      const requestKind = yield* snippetUploadRequestKind(request.origin);
      yield* capability.authorizeProductCommand(currentUser.id, input.storageProvider);
      const prepared = yield* prepareSnippetUpload(storage, currentUser.id, input).pipe(
        Effect.annotateSpans({ id: input.id }),
      );
      if (
        requestKind === "WEB" &&
        (prepared.storageProvider !== input.storageProvider ||
          !isSupportedProviderUploadTarget(input.storageProvider, prepared.upload.url))
      ) {
        yield* Effect.logError("Provider returned an unsupported Web upload target", {
          storageProvider: input.storageProvider,
        });
        return yield* new RpcError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The storage provider did not return a supported Web upload target.",
        });
      }
      return prepared;
    }),
    PublishSnippet: Effect.fn("rpc.PublishSnippet")(function* (input) {
      const capability = yield* AccountCapability;
      const drizzle = yield* Drizzle;
      const currentUser = yield* CurrentUser;
      yield* capability.authorizeProductCommand(currentUser.id, input.storageProvider);
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
                ...telemetryErrorAttributes(cause),
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
    PrepareSnippetDownload: Effect.fn("rpc.PrepareSnippetDownload")(function* (input) {
      const capability = yield* AccountCapability;
      const drizzle = yield* Drizzle;
      const storage = yield* StorageProvider;
      const currentUser = yield* CurrentUser;
      return yield* prepareSnippetDownload(
        drizzle,
        capability,
        storage,
        currentUser.id,
        input.id,
      ).pipe(Effect.annotateSpans({ id: input.id }));
    }),
    GetSnippetContent: Effect.fn("rpc.GetSnippetContent")(function* (input) {
      const capability = yield* AccountCapability;
      const drizzle = yield* Drizzle;
      const storage = yield* StorageProvider;
      const currentUser = yield* CurrentUser;
      return yield* getSnippetContent(drizzle, capability, storage, currentUser.id, input.id).pipe(
        Effect.annotateSpans({ id: input.id }),
      );
    }),
    DeleteSnippet: Effect.fn("rpc.DeleteSnippet")(function* (input) {
      const capability = yield* AccountCapability;
      const drizzle = yield* Drizzle;
      const storage = yield* StorageProvider;
      const currentUser = yield* CurrentUser;

      yield* Effect.logInfo("Deleting snippet", { id: input.id });
      yield* capability.authorizeSnippetDeletion(currentUser.id);
      return yield* deleteSnippet(drizzle, storage, currentUser.id, input.id).pipe(
        Effect.annotateSpans({ id: input.id }),
      );
    }),
  });
});
