import { Drizzle, type DrizzleService } from "@plakk/db";
import { snippets, type SnippetRow } from "@plakk/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";

import { StorageProviderService } from "../storage/StorageProvider.ts";
import { SnippetUploads } from "./SnippetUploads.ts";
import { SnippetUploadsLive, UPLOAD_HEARTBEAT_DURATION } from "./SnippetUploadsLive.ts";

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
  return { columns: [...columns], values };
};

type SelectResult = ReadonlyArray<SnippetRow | { readonly id: string }>;

const scriptedDb = (script: {
  readonly selects?: Array<SelectResult>;
  readonly snippetInserts?: Array<ReadonlyArray<SnippetRow>>;
  readonly snippetUpdates?: Array<ReadonlyArray<SnippetRow>>;
}) => {
  const selects = [...(script.selects ?? [])];
  const snippetInserts = [...(script.snippetInserts ?? [])];
  const snippetUpdates = [...(script.snippetUpdates ?? [])];
  const notifications: Array<unknown> = [];
  const transactionEvents: Array<"update" | "notify" | "commit"> = [];
  const conditions: Array<ReturnType<typeof inspectCondition>> = [];
  const updates: Array<{
    readonly set: Partial<SnippetRow>;
    readonly condition: ReturnType<typeof inspectCondition>;
  }> = [];
  const locks: Array<{ readonly strength: string; readonly skipLocked: boolean }> = [];
  const limits: Array<number> = [];
  let transactionCount = 0;

  const next = <A>(queue: Array<A>, operation: string): A => {
    const result = queue.shift();
    if (result === undefined) throw new Error(`Missing scripted result for ${operation}.`);
    return result;
  };

  const selectResult = (condition: unknown) => {
    conditions.push(inspectCondition(condition));
    const complete = (limit: number) => {
      limits.push(limit);
      return Effect.sync(() => next(selects, "select"));
    };
    return {
      limit: complete,
      for: (strength: string, options: { readonly skipLocked?: boolean }) => {
        locks.push({ strength, skipLocked: options.skipLocked === true });
        return { limit: complete };
      },
    };
  };

  const db = {
    transaction: <A, E, R>(
      body: (tx: DrizzleService["db"]) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      transactionCount += 1;
      return body(db as unknown as DrizzleService["db"]).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            transactionEvents.push("commit");
          }),
        ),
      );
    },
    select: () => ({
      from: (table: unknown) => {
        if (table !== snippets) throw new Error("Unexpected select table.");
        return { where: selectResult };
      },
    }),
    insert: (table: unknown) => ({
      values: (_values: Record<string, unknown>) => {
        if (table === snippets) {
          return {
            onConflictDoNothing: () => ({
              returning: () => Effect.sync(() => next(snippetInserts, "snippet insert returning")),
            }),
          };
        }
        throw new Error("Unexpected insert table.");
      },
    }),
    update: (table: unknown) => {
      if (table !== snippets) throw new Error("Unexpected update table.");
      return {
        set: (values: Partial<SnippetRow>) => ({
          where: (condition: unknown) => {
            const inspected = inspectCondition(condition);
            conditions.push(inspected);
            updates.push({ set: values, condition: inspected });
            return {
              returning: () =>
                Effect.sync(() => {
                  transactionEvents.push("update");
                  return next(snippetUpdates, "snippet update returning");
                }),
            };
          },
        }),
      };
    },
    delete: () => ({ where: () => Effect.void }),
    execute: (statement: unknown) =>
      Effect.sync(() => {
        notifications.push(statement);
        transactionEvents.push("notify");
      }),
  } as unknown as DrizzleService["db"];

  return {
    db,
    notifications: () => notifications,
    transactionEvents: () => transactionEvents,
    conditions: () => conditions,
    updates: () => updates,
    locks: () => locks,
    limits: () => limits,
    remaining: () => ({
      selects: selects.length,
      snippetInserts: snippetInserts.length,
      snippetUpdates: snippetUpdates.length,
    }),
    transactionCount: () => transactionCount,
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
  store: ReturnType<typeof scriptedDb>,
  storage: ReturnType<typeof makeStorage>["service"],
  effect: Effect.Effect<A, E, SnippetUploads>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SnippetUploadsLive),
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

const expectGuard = (
  condition: ReturnType<typeof inspectCondition>,
  columns: ReadonlyArray<string>,
  values: ReadonlyArray<unknown>,
) => {
  expect(condition.columns).toEqual(expect.arrayContaining([...columns]));
  expect(condition.values).toEqual(expect.arrayContaining([...values]));
};

describe("authoritative snippet uploads", () => {
  it("creates and replays one snippet idempotently", async () => {
    const createdRow = row();
    const store = scriptedDb({
      snippetInserts: [[createdRow], [], []],
      selects: [[createdRow], [createdRow]],
    });
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
    expect(store.notifications()).toHaveLength(0);
    expect(store.transactionCount()).toBe(3);
    expect(store.remaining()).toEqual({ selects: 0, snippetInserts: 0, snippetUpdates: 0 });
  });

  it("prepares repeatedly without synchronizing the scoped destination", async () => {
    const store = scriptedDb({ selects: [[row()], [row()]] });
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
    expect(store.notifications()).toHaveLength(0);
    expect(store.remaining()).toEqual({ selects: 0, snippetInserts: 0, snippetUpdates: 0 });
  });

  it("extends the heartbeat and publishes only rows returned by guarded expiry", async () => {
    const heartbeatTime = baseTime.getTime() + 10_000;
    const heartbeatExpiresAt = DateTime.toDateUtc(
      DateTime.makeUnsafe(heartbeatTime + UPLOAD_HEARTBEAT_DURATION),
    );
    const heartbeatRow = row({ uploadHeartbeatExpiresAt: heartbeatExpiresAt });
    const failedRow = row({
      uploadStatus: "CLIENT_UPLOAD_FAILED",
      uploadHeartbeatExpiresAt: null,
    });
    const store = scriptedDb({
      selects: [[row()], [], [{ id: createInput.id }], []],
      snippetUpdates: [[heartbeatRow], [failedRow]],
    });
    const storage = makeStorage();

    const result = await runWith(
      store,
      storage.service,
      Effect.gen(function* () {
        yield* TestClock.setTime(heartbeatTime);
        const uploads = yield* SnippetUploads;
        const heartbeat = yield* uploads.heartbeat("user-1", createInput.id);
        yield* TestClock.setTime(Date.parse(heartbeat.expiresAt) - 1);
        const beforeDeadline = yield* uploads.expire;
        yield* TestClock.setTime(Date.parse(heartbeat.expiresAt) + 1);
        const [expired, replay] = yield* Effect.all([uploads.expire, uploads.expire], {
          concurrency: "unbounded",
        });
        return { heartbeat, beforeDeadline, expired, replay };
      }),
    );

    expect(Date.parse(result.heartbeat.expiresAt)).toBe(heartbeatExpiresAt.getTime());
    expect(result).toMatchObject({ beforeDeadline: 0, expired: 1, replay: 0 });
    expect(store.notifications()).toHaveLength(0);
    expect(store.locks()).toEqual([
      { strength: "update", skipLocked: true },
      { strength: "update", skipLocked: true },
      { strength: "update", skipLocked: true },
    ]);
    expect(store.limits()).toEqual([1, 100, 100, 100]);
    expectGuard(
      store.updates()[0]!.condition,
      ["id", "owner_workos_user_id", "upload_status", "upload_heartbeat_expires_at", "deleted_at"],
      ["UPLOADING", expect.any(Date)],
    );
    expect(store.updates()[1]!.set).toMatchObject({
      uploadStatus: "CLIENT_UPLOAD_FAILED",
      uploadHeartbeatExpiresAt: null,
    });
    expectGuard(
      store.updates()[1]!.condition,
      ["id", "upload_status", "upload_heartbeat_expires_at", "deleted_at"],
      ["UPLOADING", expect.any(Date)],
    );
    expect(store.updates()[1]!.condition.columns).not.toContain("owner_workos_user_id");
    expect(store.transactionCount()).toBe(3);
    expect(store.remaining()).toEqual({ selects: 0, snippetInserts: 0, snippetUpdates: 0 });
  });

  it("keeps FAILED stable until explicit retry and completes idempotently", async () => {
    const failedRow = row({ uploadStatus: "FAILED", uploadHeartbeatExpiresAt: null });
    const retriedRow = row();
    const uploadedRow = row({
      uploadStatus: "UPLOADED",
      uploadHeartbeatExpiresAt: null,
      storageObjectId: "provider-object",
    });
    const store = scriptedDb({
      selects: [
        [row()],
        [failedRow],
        [failedRow],
        [failedRow],
        [retriedRow],
        [retriedRow],
        [uploadedRow],
        [uploadedRow],
      ],
      snippetUpdates: [[failedRow], [retriedRow], [uploadedRow]],
    });
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
          uploads.complete("user-1", { id: createInput.id, storageObjectId: "provider-object" }),
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
    expect(store.notifications()).toHaveLength(1);
    const notifyIndex = store.transactionEvents().indexOf("notify");
    expect(store.transactionEvents().slice(notifyIndex - 1, notifyIndex + 2)).toEqual([
      "update",
      "notify",
      "commit",
    ]);
    expect(store.updates()).toHaveLength(3);
    expectGuard(
      store.updates()[0]!.condition,
      ["id", "owner_workos_user_id", "upload_status", "deleted_at"],
      ["UPLOADING"],
    );
    expectGuard(
      store.updates()[1]!.condition,
      ["id", "owner_workos_user_id", "upload_status", "deleted_at"],
      ["FAILED"],
    );
    expectGuard(
      store.updates()[2]!.condition,
      ["id", "owner_workos_user_id", "upload_status", "upload_heartbeat_expires_at", "deleted_at"],
      ["UPLOADING", expect.any(Date)],
    );
    expect(store.remaining()).toEqual({ selects: 0, snippetInserts: 0, snippetUpdates: 0 });
  });

  it("retries a heartbeat-expired client failure through the transitional failure path", async () => {
    const failedRow = row({
      uploadStatus: "CLIENT_UPLOAD_FAILED",
      uploadHeartbeatExpiresAt: null,
    });
    const retriedRow = row();
    const store = scriptedDb({
      selects: [[failedRow]],
      snippetUpdates: [[retriedRow]],
    });
    const storage = makeStorage();

    const retried = await runWith(
      store,
      storage.service,
      Effect.gen(function* () {
        yield* TestClock.setTime(baseTime.getTime());
        const uploads = yield* SnippetUploads;
        return yield* uploads.retry("user-1", createInput.id);
      }),
    );

    expect(retried.uploadStatus).toBe("UPLOADING");
    expect(store.notifications()).toHaveLength(0);
    expectGuard(
      store.updates()[0]!.condition,
      ["id", "owner_workos_user_id", "upload_status", "deleted_at"],
      ["FAILED", "CLIENT_UPLOAD_FAILED"],
    );
    expect(store.remaining()).toEqual({ selects: 0, snippetInserts: 0, snippetUpdates: 0 });
  });

  it("rejects expired or already-deleted completion before mutation", async () => {
    const expiredRow = row({ uploadHeartbeatExpiresAt: baseTime });
    const store = scriptedDb({ selects: [[expiredRow], []] });
    const storage = makeStorage();

    const result = await runWith(
      store,
      storage.service,
      Effect.gen(function* () {
        const uploads = yield* SnippetUploads;
        yield* TestClock.setTime(baseTime.getTime() + 1);
        const expired = yield* Effect.flip(
          uploads.complete("user-1", { id: createInput.id, storageObjectId: "provider-object" }),
        );
        const deleted = yield* Effect.flip(
          uploads.complete("user-1", { id: createInput.id, storageObjectId: "provider-object" }),
        );
        return { expired, deleted };
      }),
    );

    expect(result.expired).toMatchObject({ code: "CONFLICT" });
    expect(result.deleted).toMatchObject({ code: "NOT_FOUND" });
    expect(store.notifications()).toHaveLength(0);
    expect(store.updates()).toHaveLength(0);
    expect(store.remaining()).toEqual({ selects: 0, snippetInserts: 0, snippetUpdates: 0 });
  });

  it("does not complete when deletion wins the guarded update race", async () => {
    const store = scriptedDb({
      selects: [[row()], []],
      snippetUpdates: [[]],
    });
    const storage = makeStorage();

    const error = await runWith(
      store,
      storage.service,
      Effect.gen(function* () {
        yield* TestClock.setTime(baseTime.getTime());
        const uploads = yield* SnippetUploads;
        return yield* Effect.flip(
          uploads.complete("user-1", { id: createInput.id, storageObjectId: "provider-object" }),
        );
      }),
    );

    expect(error).toMatchObject({ code: "CONFLICT" });
    expect(store.notifications()).toHaveLength(0);
    expect(store.updates()).toHaveLength(1);
    expectGuard(
      store.updates()[0]!.condition,
      ["id", "owner_workos_user_id", "upload_status", "upload_heartbeat_expires_at", "deleted_at"],
      ["UPLOADING", expect.any(Date)],
    );
    expect(store.remaining()).toEqual({ selects: 0, snippetInserts: 0, snippetUpdates: 0 });
  });
});
