import { Drizzle, type DrizzleService } from "@plakk/db";
import { snippetChangeFeeds, snippetChanges, snippets, type SnippetRow } from "@plakk/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";

import { StorageProviderService } from "./storage/StorageProvider.ts";
import { SnippetUploads, UPLOAD_HEARTBEAT_DURATION } from "./SnippetUploads.ts";

const baseDateTime = DateTime.makeUnsafe("2026-07-15T12:00:00Z");
const baseTime = DateTime.toDateUtc(baseDateTime);

const row = (overrides: Partial<SnippetRow> = {}): SnippetRow => ({
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  ownerWorkosUserId: "user-1",
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: null,
  uploadStatus: "UPLOADING",
  uploadHeartbeatExpiresAt: DateTime.toDateUtc(
    DateTime.add(baseDateTime, { milliseconds: UPLOAD_HEARTBEAT_DURATION }),
  ),
  fileName: "note.md",
  byteSize: 12,
  deletedAt: null,
  createdAt: baseTime,
  updatedAt: baseTime,
  ...overrides,
});

const inspectCondition = (condition: unknown) => {
  const columns = new Set<string>();
  const values: Array<unknown> = [];
  const visit = (chunk: unknown): void => {
    if (typeof chunk !== "object" || chunk === null) return;
    if ("name" in chunk && typeof chunk.name === "string" && "table" in chunk) {
      columns.add(chunk.name);
      return;
    }
    if ("queryChunks" in chunk && Array.isArray(chunk.queryChunks)) {
      for (const child of chunk.queryChunks) visit(child);
      return;
    }
    if ("value" in chunk && !Array.isArray(chunk.value)) values.push(chunk.value);
  };
  visit(condition);
  return { columns, values };
};

const expectColumns = (condition: unknown, expected: ReadonlyArray<string>) => {
  const inspected = inspectCondition(condition);
  for (const column of expected) expect(inspected.columns).toContain(column);
  return inspected;
};

const statefulDb = (initial: SnippetRow | null = null) => {
  let stored = initial;
  let latestSequence = 0n;
  const changes: Array<{ readonly snapshot: unknown }> = [];
  const updates: Array<{
    readonly set: Partial<SnippetRow>;
    readonly columns: ReadonlyArray<string>;
    readonly parameters: ReadonlyArray<unknown>;
  }> = [];

  const db = {
    transaction: <A, E, R>(
      body: (tx: DrizzleService["db"]) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      const before = stored;
      const changeCount = changes.length;
      return body(db as unknown as DrizzleService["db"]).pipe(
        Effect.tapCause(() =>
          Effect.sync(() => {
            stored = before;
            changes.length = changeCount;
          }),
        ),
      );
    },
    select: (selection?: unknown) => ({
      from: (table: unknown) => {
        if (table !== snippets) throw new Error("Unexpected select table");
        return {
          where: (condition: unknown) => {
            const inspected =
              selection === undefined
                ? expectColumns(condition, ["id", "owner_workos_user_id", "deleted_at"])
                : expectColumns(condition, [
                    "upload_status",
                    "upload_heartbeat_expires_at",
                    "deleted_at",
                  ]);
            const result = () => {
              if (selection === undefined) {
                return stored === null || stored.deletedAt !== null ? [] : [stored];
              }
              const now = inspected.values.find((value): value is Date => value instanceof Date);
              const expiresAt = stored?.uploadHeartbeatExpiresAt;
              const isExpired =
                stored?.uploadStatus === "UPLOADING" &&
                stored.deletedAt === null &&
                expiresAt instanceof Date &&
                now !== undefined &&
                expiresAt.getTime() <= now.getTime();
              return isExpired && stored !== null ? [{ id: stored.id }] : [];
            };
            return {
              limit: () => Effect.sync(result),
              for: () => ({ limit: () => Effect.sync(result) }),
            };
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === snippets) {
          return {
            onConflictDoNothing: () => ({
              returning: () =>
                Effect.sync(() => {
                  if (stored !== null) return [];
                  stored = values as unknown as SnippetRow;
                  return [stored];
                }),
            }),
          };
        }
        if (table === snippetChangeFeeds) {
          return {
            onConflictDoUpdate: () => ({
              returning: () => Effect.sync(() => [{ latestSequence: (latestSequence += 1n) }]),
            }),
          };
        }
        if (table === snippetChanges) {
          return Effect.sync(() => {
            changes.push({ snapshot: values.snapshot });
          });
        }
        throw new Error("Unexpected insert table");
      },
    }),
    update: (table: unknown) => {
      if (table !== snippets) throw new Error("Unexpected update table");
      return {
        set: (values: Partial<SnippetRow>) => ({
          where: (condition: unknown) => {
            const inspected = inspectCondition(condition);
            updates.push({
              set: values,
              columns: [...inspected.columns],
              parameters: inspected.values,
            });
            return {
              returning: () =>
                Effect.sync(() => {
                  if (stored === null || stored.deletedAt !== null) return [];
                  stored = { ...stored, ...values };
                  return [stored];
                }),
            };
          },
        }),
      };
    },
    delete: () => ({ where: () => Effect.void }),
  } as unknown as DrizzleService["db"];

  return {
    db,
    stored: () => stored,
    changes: () => changes.map((change) => change.snapshot),
    updates: () => updates,
    markDeleted: () => {
      if (stored !== null) stored = { ...stored, deletedAt: baseTime };
    },
  };
};

const prepared = {
  storageProvider: "GOOGLE_DRIVE" as const,
  storageObjectId: null,
  upload: {
    method: "POST" as const,
    url: "https://upload.example/session",
    headers: [{ name: "X-Upload", value: "secret" }],
    strategy: { type: "single_request" as const },
  },
  expiresAt: "2026-07-15T12:10:00.000Z",
};

const makeStorage = () => {
  const prepareUpload = vi.fn(() => Effect.succeed(prepared));
  return {
    service: StorageProviderService.of({
      ensureConnected: () => Effect.void,
      prepareUpload,
      getDestinationUrl: () => Effect.succeed("https://drive.example/folder"),
      downloadObject: () => Effect.succeed(new Uint8Array()),
      getDownloadUrl: () => Effect.succeed("https://download.example"),
      getDownloadTarget: () => Effect.succeed({ url: "https://download.example", headers: [] }),
    }),
    prepareUpload,
  };
};

const runWith = <A, E>(
  store: ReturnType<typeof statefulDb>,
  storage: ReturnType<typeof makeStorage>["service"],
  effect: Effect.Effect<A, E, SnippetUploads>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SnippetUploads.Live),
      Effect.provideService(Drizzle, { db: store.db }),
      Effect.provideService(StorageProviderService, storage),
      Effect.provide(TestClock.layer()),
    ),
  );

const createInput = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "note.md",
  byteSize: 12,
  storageProvider: "GOOGLE_DRIVE" as const,
};

describe("authoritative snippet uploads", () => {
  it("creates and replays one snippet idempotently", async () => {
    const store = statefulDb();
    const storage = makeStorage();

    const result = await runWith(
      store,
      storage.service,
      Effect.gen(function* () {
        yield* TestClock.setTime(baseTime.getTime());
        const uploads = yield* SnippetUploads;
        const created = yield* uploads.create("user-1", createInput);
        const replayed = yield* uploads.create("user-1", createInput);
        const conflict = yield* Effect.flip(
          uploads.create("user-1", { ...createInput, fileName: "different.md" }),
        );
        return { created, replayed, conflict };
      }),
    );

    expect(result.created).toEqual(result.replayed);
    expect(result.created).toMatchObject({
      ...createInput,
      storageObjectId: null,
      uploadStatus: "UPLOADING",
    });
    expect(result.conflict).toMatchObject({ code: "CONFLICT" });
    expect(store.changes()).toHaveLength(1);
  });

  it("prepares repeatedly without synchronizing the scoped destination", async () => {
    const store = statefulDb(row());
    const storage = makeStorage();

    const results = await runWith(
      store,
      storage.service,
      Effect.gen(function* () {
        yield* TestClock.setTime(baseTime.getTime());
        const uploads = yield* SnippetUploads;
        return yield* Effect.all([
          uploads.prepare("user-1", { id: createInput.id, mediaType: "text/markdown" }),
          uploads.prepare("user-1", { id: createInput.id, mediaType: "text/markdown" }),
        ]);
      }),
    );

    expect(results).toEqual([prepared, prepared]);
    expect(storage.prepareUpload).toHaveBeenCalledTimes(2);
    expect(store.changes()).toHaveLength(0);
  });

  it("extends heartbeats and expires an abandoned upload exactly once", async () => {
    const store = statefulDb(row());
    const storage = makeStorage();

    const result = await runWith(
      store,
      storage.service,
      Effect.gen(function* () {
        yield* TestClock.setTime(baseTime.getTime() + 10_000);
        const uploads = yield* SnippetUploads;
        const heartbeat = yield* uploads.heartbeat("user-1", createInput.id);
        yield* TestClock.setTime(Date.parse(heartbeat.expiresAt) - 1);
        const beforeDeadline = yield* uploads.expire;
        yield* TestClock.setTime(Date.parse(heartbeat.expiresAt) + 1);
        const expired = yield* uploads.expire;
        const replay = yield* uploads.expire;
        return { heartbeat, beforeDeadline, expired, replay };
      }),
    );

    expect(Date.parse(result.heartbeat.expiresAt)).toBe(
      baseTime.getTime() + 10_000 + UPLOAD_HEARTBEAT_DURATION,
    );
    expect(result).toMatchObject({ beforeDeadline: 0, expired: 1, replay: 0 });
    expect(store.stored()).toMatchObject({
      uploadStatus: "FAILED",
      uploadHeartbeatExpiresAt: null,
    });
    expect(store.changes()).toHaveLength(1);
    expect(store.updates()).toHaveLength(2);
    expect(store.updates()[0]).toMatchObject({
      columns: expect.arrayContaining([
        "id",
        "owner_workos_user_id",
        "upload_status",
        "upload_heartbeat_expires_at",
        "deleted_at",
      ]),
      parameters: expect.arrayContaining(["UPLOADING", expect.any(Date)]),
    });
    expect(store.updates()[1]).toMatchObject({
      set: { uploadStatus: "FAILED", uploadHeartbeatExpiresAt: null },
      columns: expect.arrayContaining([
        "id",
        "upload_status",
        "upload_heartbeat_expires_at",
        "deleted_at",
      ]),
      parameters: expect.arrayContaining(["UPLOADING", expect.any(Date)]),
    });
    expect(store.updates()[1]?.columns).not.toContain("owner_workos_user_id");
  });

  it("keeps FAILED stable until explicit retry and completes idempotently", async () => {
    const store = statefulDb(row());
    const storage = makeStorage();

    const result = await runWith(
      store,
      storage.service,
      Effect.gen(function* () {
        yield* TestClock.setTime(baseTime.getTime());
        const uploads = yield* SnippetUploads;
        const failed = yield* uploads.fail("user-1", createInput.id);
        const replayedFailure = yield* uploads.fail("user-1", createInput.id);
        const lateCompletion = yield* Effect.flip(
          uploads.complete("user-1", {
            id: createInput.id,
            storageObjectId: "provider-object",
          }),
        );
        const retried = yield* uploads.retry("user-1", createInput.id);
        const replayedRetry = yield* uploads.retry("user-1", createInput.id);
        const completed = yield* uploads.complete("user-1", {
          id: createInput.id,
          storageObjectId: "provider-object",
        });
        const replayed = yield* uploads.complete("user-1", {
          id: createInput.id,
          storageObjectId: "provider-object",
        });
        const conflictingCompletion = yield* Effect.flip(
          uploads.complete("user-1", {
            id: createInput.id,
            storageObjectId: "different-provider-object",
          }),
        );
        return {
          failed,
          replayedFailure,
          lateCompletion,
          retried,
          replayedRetry,
          completed,
          replayed,
          conflictingCompletion,
        };
      }),
    );

    expect(result.failed).toEqual(result.replayedFailure);
    expect(result.lateCompletion).toMatchObject({ code: "CONFLICT" });
    expect(result.retried).toEqual(result.replayedRetry);
    expect(result.completed).toEqual(result.replayed);
    expect(result.conflictingCompletion).toMatchObject({ code: "CONFLICT" });
    expect(result.completed).toMatchObject({
      uploadStatus: "UPLOADED",
      storageObjectId: "provider-object",
    });
    expect(store.changes()).toMatchObject([
      { uploadStatus: "FAILED" },
      { uploadStatus: "UPLOADING" },
      { uploadStatus: "UPLOADED" },
    ]);
    expect(store.updates()).toMatchObject([
      {
        set: { uploadStatus: "FAILED", uploadHeartbeatExpiresAt: null },
        columns: expect.arrayContaining([
          "id",
          "owner_workos_user_id",
          "upload_status",
          "deleted_at",
        ]),
        parameters: expect.arrayContaining(["UPLOADING"]),
      },
      {
        set: { uploadStatus: "UPLOADING" },
        columns: expect.arrayContaining([
          "id",
          "owner_workos_user_id",
          "upload_status",
          "deleted_at",
        ]),
        parameters: expect.arrayContaining(["FAILED"]),
      },
      {
        set: { uploadStatus: "UPLOADED", storageObjectId: "provider-object" },
        columns: expect.arrayContaining([
          "id",
          "owner_workos_user_id",
          "upload_status",
          "upload_heartbeat_expires_at",
          "deleted_at",
        ]),
        parameters: expect.arrayContaining(["UPLOADING", expect.any(Date)]),
      },
    ]);
  });

  it("never completes a deleted or expired upload", async () => {
    const store = statefulDb(row());
    const storage = makeStorage();

    const result = await runWith(
      store,
      storage.service,
      Effect.gen(function* () {
        const uploads = yield* SnippetUploads;
        yield* TestClock.setTime(baseTime.getTime() + UPLOAD_HEARTBEAT_DURATION + 1);
        const expired = yield* Effect.flip(
          uploads.complete("user-1", {
            id: createInput.id,
            storageObjectId: "provider-object",
          }),
        );
        yield* Effect.sync(store.markDeleted);
        const deleted = yield* Effect.flip(
          uploads.complete("user-1", {
            id: createInput.id,
            storageObjectId: "provider-object",
          }),
        );
        return { expired, deleted };
      }),
    );

    expect(result.expired).toMatchObject({ code: "CONFLICT" });
    expect(result.deleted).toMatchObject({ code: "NOT_FOUND" });
    expect(store.changes()).toHaveLength(0);
    expect(store.updates()).toHaveLength(0);
  });
});
