import { Drizzle, eq } from "@plakk/db";
import { snippetChangeFeeds, snippetChanges, snippets } from "@plakk/db/schema";
import { describe, expect, it } from "vite-plus/test";
import { ConfigProvider, DateTime, Effect, Exit, Layer, Scope } from "effect";

import { makeUploadExpirationLayer } from "./ServerRuntime.ts";
import { SnippetUploads } from "./SnippetUploads.ts";
import { StorageProviderService } from "./storage/StorageProvider.ts";

const databaseUrl = process.env.PLAKK_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

const ownerWorkosUserId = "server-runtime-integration-test";
const unexpectedStorageOperation = Effect.fn(
  "ServerRuntimePostgresTest.unexpectedStorageOperation",
)(() => Effect.die("Expiration must not access provider storage."));

const StorageProviderTest = Layer.succeed(
  StorageProviderService,
  StorageProviderService.of({
    ensureConnected: () => Effect.void,
    prepareUpload: unexpectedStorageOperation,
    getDestinationUrl: unexpectedStorageOperation,
    downloadObject: unexpectedStorageOperation,
    getDownloadUrl: unexpectedStorageOperation,
    getDownloadTarget: unexpectedStorageOperation,
  }),
);

const ConfigTest = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ DATABASE_URL: databaseUrl ?? "not-configured" }),
);
const DatabaseTest = Drizzle.Live.pipe(Layer.provide(ConfigTest));
const UploadsTest = SnippetUploads.Live.pipe(
  Layer.provideMerge(DatabaseTest),
  Layer.provide(StorageProviderTest),
);
const ExpirationTest = makeUploadExpirationLayer("1 hour").pipe(Layer.provide(UploadsTest));

const cleanupOwner = Effect.fn("ServerRuntimePostgresTest.cleanupOwner")(function* () {
  const drizzle = yield* Drizzle;
  yield* drizzle.db
    .delete(snippetChanges)
    .where(eq(snippetChanges.ownerWorkosUserId, ownerWorkosUserId));
  yield* drizzle.db
    .delete(snippetChangeFeeds)
    .where(eq(snippetChangeFeeds.ownerWorkosUserId, ownerWorkosUserId));
  yield* drizzle.db.delete(snippets).where(eq(snippets.ownerWorkosUserId, ownerWorkosUserId));
});

const seedOverdueUpload = Effect.fn("ServerRuntimePostgresTest.seedOverdueUpload")(function* (
  id: string,
) {
  const drizzle = yield* Drizzle;
  const expiredAt = DateTime.toDateUtc(DateTime.subtract(yield* DateTime.now, { minutes: 1 }));
  yield* drizzle.db.insert(snippets).values({
    id,
    ownerWorkosUserId,
    storageProvider: "GOOGLE_DRIVE",
    storageObjectId: null,
    uploadStatus: "UPLOADING",
    uploadHeartbeatExpiresAt: expiredAt,
    fileName: `${id}.txt`,
    byteSize: 4,
    deletedAt: null,
    createdAt: expiredAt,
    updatedAt: expiredAt,
  });
});

const readOutcome = Effect.fn("ServerRuntimePostgresTest.readOutcome")(function* (id: string) {
  const drizzle = yield* Drizzle;
  const [snippet] = yield* drizzle.db.select().from(snippets).where(eq(snippets.id, id)).limit(1);
  const changes = yield* drizzle.db
    .select()
    .from(snippetChanges)
    .where(eq(snippetChanges.snippetId, id));
  return { snippet, changes };
});

const buildAndCloseExpirationRuntime = Effect.fn(
  "ServerRuntimePostgresTest.buildAndCloseExpirationRuntime",
)(function* () {
  const scope = yield* Scope.make();
  yield* Layer.buildWithScope(ExpirationTest, scope);
  yield* Scope.close(scope, Exit.void);
});

describePostgres("persistent backend expiration with PostgreSQL", () => {
  it("restarts around an overdue upload without duplicating its transition or feed entry", async () => {
    const id = "5d32b16e-7603-4d08-b413-f31abbd47120";
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* cleanupOwner();
        yield* seedOverdueUpload(id);
        yield* buildAndCloseExpirationRuntime();
        yield* buildAndCloseExpirationRuntime();

        const outcome = yield* readOutcome(id);
        expect(outcome.snippet?.uploadStatus).toBe("CLIENT_UPLOAD_FAILED");
        expect(outcome.changes).toHaveLength(1);
        expect(outcome.changes[0]?.snapshot?.uploadStatus).toBe("CLIENT_UPLOAD_FAILED");
      }).pipe(Effect.ensuring(cleanupOwner().pipe(Effect.orDie)), Effect.provide(DatabaseTest)),
    );
  });

  it("runs overlapping startup sweeps without duplicate transitions or feed entries", async () => {
    const id = "70f31d55-20f1-4e10-99c1-1b2335c08f55";
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* cleanupOwner();
        yield* seedOverdueUpload(id);
        yield* Effect.all([buildAndCloseExpirationRuntime(), buildAndCloseExpirationRuntime()], {
          concurrency: "unbounded",
        });

        const outcome = yield* readOutcome(id);
        expect(outcome.snippet?.uploadStatus).toBe("CLIENT_UPLOAD_FAILED");
        expect(outcome.changes).toHaveLength(1);
      }).pipe(Effect.ensuring(cleanupOwner().pipe(Effect.orDie)), Effect.provide(DatabaseTest)),
    );
  });
});
