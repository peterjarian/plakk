import type { ApiSnippet, PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import { ManagedSnippetContentError } from "@plakk/shared/SnippetReplica";
import { describe, expect, it, vi } from "vite-plus/test";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import type { SnippetIngestPayload } from "../ipc/contracts.ts";
import { StorageUpload, StorageUploadError } from "../storageUpload.ts";
import { DesktopManagedSnippetContent } from "./ManagedSnippetContent.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";
import { SnippetUploadOutbox, type SnippetUploadOutboxEntry } from "./SnippetUploadOutbox.ts";
import { SnippetUploadRemote } from "./SnippetUploadRemote.ts";

const account = { id: "user-1", accessToken: "access-token" };
const snippetId = "0d1e2f3a-4567-4890-8abc-def012345678";
const createdAt = "2026-07-15T20:00:00.000Z";
const text = "A stable local text snippet";
const bytes = new TextEncoder().encode(text);
const input: SnippetIngestPayload = {
  id: snippetId,
  fileName: `${snippetId}.txt`,
  byteSize: bytes.byteLength,
  mediaType: "text/plain; charset=utf-8",
  storageProvider: "GOOGLE_DRIVE",
  bytes,
};
const prepared: PreparedStorageUpload = {
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: null,
  upload: {
    method: "PUT",
    url: "https://upload.example/file",
    headers: [],
    strategy: { type: "single_request" },
  },
  expiresAt: null,
};

const apiSnippet = (uploadStatus: ApiSnippet["uploadStatus"]): ApiSnippet => ({
  id: snippetId,
  fileName: input.fileName,
  byteSize: input.byteSize,
  storageProvider: input.storageProvider,
  storageObjectId: uploadStatus === "UPLOADED" ? "drive-file-id" : null,
  uploadStatus,
  createdAt,
  updatedAt: createdAt,
});

const harness = (options?: {
  readonly ingestFailure?: ManagedSnippetContentError;
  readonly stallIngest?: boolean;
  readonly longUpload?: boolean;
  readonly uploadFailures?: number;
  readonly heartbeatFailures?: number;
  readonly completeFailures?: number;
}) => {
  const outbox = new Map<string, Array<SnippetUploadOutboxEntry>>();
  const content = new Map<string, Uint8Array>();
  const calls = {
    create: 0,
    prepare: 0,
    heartbeat: 0,
    fail: 0,
    retry: 0,
    complete: 0,
    delete: 0,
    upload: 0,
    discard: 0,
    get: 0,
    available: 0,
  };
  const key = (accountId: string, id: string) => `${accountId}/${id}`;
  const accountEntries = (accountId: string) => outbox.get(accountId) ?? [];
  let remainingUploadFailures = options?.uploadFailures ?? 0;
  let remainingHeartbeatFailures = options?.heartbeatFailures ?? 0;
  let remainingCompleteFailures = options?.completeFailures ?? 0;

  const dependencies = Layer.mergeAll(
    Layer.succeed(
      DesktopManagedSnippetContent,
      DesktopManagedSnippetContent.of({
        ingest: (accountId, payload) =>
          options?.ingestFailure !== undefined
            ? Effect.fail(options.ingestFailure)
            : options?.stallIngest === true
              ? Effect.never
              : Effect.sync(() => {
                  content.set(
                    key(accountId, payload.id),
                    "bytes" in payload ? payload.bytes : new Uint8Array(payload.byteSize),
                  );
                  return `/managed/${payload.id}`;
                }),
        path: (accountId, id, byteSize) =>
          Effect.suspend(() => {
            const value = content.get(key(accountId, id));
            return value?.byteLength === byteSize
              ? Effect.succeed(`/managed/${id}`)
              : Effect.fail(
                  new ManagedSnippetContentError({
                    cause: null,
                    reason: "The local copy of this snippet is unavailable.",
                  }),
                );
          }),
        get: (accountId, id) =>
          Effect.sync(() => {
            calls.get += 1;
            return content.get(key(accountId, id)) ?? null;
          }),
        available: (accountId, id, byteSize) =>
          Effect.sync(() => {
            calls.available += 1;
            return content.get(key(accountId, id))?.byteLength === byteSize;
          }),
        put: (accountId, id, value) =>
          Effect.sync(() => {
            content.set(key(accountId, id), value);
          }),
        discard: (accountId, id) =>
          Effect.sync(() => {
            calls.discard += 1;
            content.delete(key(accountId, id));
          }),
      }),
    ),
    Layer.succeed(
      SnippetUploadOutbox,
      SnippetUploadOutbox.of({
        list: (accountId) => Effect.sync(() => [...accountEntries(accountId)]),
        get: (accountId, id) =>
          Effect.sync(() => accountEntries(accountId).find((entry) => entry.id === id) ?? null),
        put: (accountId, entry) =>
          Effect.sync(() => {
            const entries = accountEntries(accountId);
            outbox.set(
              accountId,
              entries.some((current) => current.id === entry.id)
                ? entries.map((current) => (current.id === entry.id ? entry : current))
                : [entry, ...entries],
            );
          }),
        remove: (accountId, id) =>
          Effect.sync(() => {
            outbox.set(
              accountId,
              accountEntries(accountId).filter((entry) => entry.id !== id),
            );
          }),
      }),
    ),
    Layer.succeed(
      SnippetUploadRemote,
      SnippetUploadRemote.of({
        create: () =>
          Effect.sync(() => {
            calls.create += 1;
            return apiSnippet("UPLOADING");
          }),
        prepare: () =>
          Effect.sync(() => {
            calls.prepare += 1;
            return prepared;
          }),
        heartbeat: () =>
          Effect.suspend(() => {
            calls.heartbeat += 1;
            if (remainingHeartbeatFailures > 0) {
              remainingHeartbeatFailures -= 1;
              return Effect.fail({
                _tag: "RpcError",
                message: "The upload heartbeat expired.",
              } as never);
            }
            return Effect.succeed({ expiresAt: "2026-07-15T20:01:00.000Z" });
          }),
        fail: () =>
          Effect.sync(() => {
            calls.fail += 1;
            return apiSnippet("FAILED");
          }),
        retry: () =>
          Effect.sync(() => {
            calls.retry += 1;
            return apiSnippet("UPLOADING");
          }),
        complete: () =>
          Effect.suspend(() => {
            calls.complete += 1;
            if (remainingCompleteFailures > 0) {
              remainingCompleteFailures -= 1;
              return Effect.fail({ _tag: "RpcClientError" } as never);
            }
            return Effect.succeed(apiSnippet("UPLOADED"));
          }),
        delete: () =>
          Effect.sync(() => {
            calls.delete += 1;
          }),
      }),
    ),
    Layer.succeed(
      StorageUpload,
      StorageUpload.of({
        upload: (_payload, onProgress) =>
          Effect.gen(function* () {
            calls.upload += 1;
            onProgress(25);
            if (remainingUploadFailures > 0) {
              remainingUploadFailures -= 1;
              return yield* new StorageUploadError({
                cause: Object.assign(new Error("network unavailable"), { code: "ENETDOWN" }),
                message: "Could not reach the upload provider.",
                retryable: true,
              });
            }
            if (options?.longUpload === true) yield* Effect.sleep("45 seconds");
            onProgress(100);
            return { storageObjectId: "drive-file-id" };
          }),
      }),
    ),
  );

  const layer = SnippetUploadEngine.Live.pipe(Layer.provide(dependencies));
  const run = <A, E>(effect: Effect.Effect<A, E, SnippetUploadEngine>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));

  return { calls, content, layer, outbox, run };
};

describe("SnippetUploadEngine", () => {
  it("durably queues offline, restarts with the same id and local text, then completes", async () => {
    const test = harness();

    await test.run(SnippetUploadEngine.use((engine) => engine.ingest(account.id, input)));

    expect(test.outbox.get(account.id)?.[0]?.phase).toBe("QUEUED");
    expect(test.calls.create).toBe(0);

    const projection = await test.run(
      SnippetUploadEngine.use((engine) => engine.project(account.id, [])),
    );
    expect(projection).toMatchObject([
      {
        id: snippetId,
        fileName: input.fileName,
        localTextContent: text,
        contentAvailable: true,
        localState: { phase: "QUEUED" },
      },
    ]);

    await test.run(SnippetUploadEngine.use((engine) => engine.resume(account)));
    await vi.waitFor(() => expect(test.outbox.get(account.id)?.[0]?.phase).toBe("UPLOADED"));

    expect(test.calls).toMatchObject({ create: 1, prepare: 1, heartbeat: 1, complete: 1 });
  });

  it("replays prepared work without creating a second authoritative snippet", async () => {
    const test = harness();
    test.content.set(`${account.id}/${snippetId}`, bytes);
    test.outbox.set(account.id, [
      {
        id: snippetId,
        fileName: input.fileName,
        byteSize: input.byteSize,
        mediaType: input.mediaType,
        storageProvider: input.storageProvider,
        phase: "QUEUED",
        progress: 0,
        storageObjectId: null,
        authoritativeStatus: "UPLOADING",
        errorMessage: null,
        canRetry: false,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    await test.run(SnippetUploadEngine.use((engine) => engine.resume(account)));
    await vi.waitFor(() => expect(test.outbox.get(account.id)?.[0]?.phase).toBe("UPLOADED"));

    expect(test.calls.create).toBe(0);
    expect(test.calls.complete).toBe(1);
  });

  it("recovers a still-live persisted upload with fresh preparation instead of failing it", async () => {
    const test = harness();
    test.content.set(`${account.id}/${snippetId}`, bytes);
    test.outbox.set(account.id, [
      {
        id: snippetId,
        fileName: input.fileName,
        byteSize: input.byteSize,
        mediaType: input.mediaType,
        storageProvider: input.storageProvider,
        phase: "UPLOADING",
        progress: 25,
        storageObjectId: null,
        authoritativeStatus: "UPLOADING",
        errorMessage: null,
        canRetry: false,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    await test.run(SnippetUploadEngine.use((engine) => engine.resume(account)));
    await vi.waitFor(() => expect(test.outbox.get(account.id)?.[0]?.phase).toBe("UPLOADED"));

    expect(test.calls.create).toBe(0);
    expect(test.calls.fail).toBe(0);
    expect(test.calls.prepare).toBe(1);
    expect(test.calls.complete).toBe(1);
  });

  it("publishes an expired persisted upload as failed before allowing retry", async () => {
    const test = harness({ heartbeatFailures: 1 });
    test.content.set(`${account.id}/${snippetId}`, bytes);
    test.outbox.set(account.id, [
      {
        id: snippetId,
        fileName: input.fileName,
        byteSize: input.byteSize,
        mediaType: input.mediaType,
        storageProvider: input.storageProvider,
        phase: "UPLOADING",
        progress: 25,
        storageObjectId: null,
        authoritativeStatus: "UPLOADING",
        errorMessage: null,
        canRetry: false,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    await test.run(SnippetUploadEngine.use((engine) => engine.resume(account)));

    expect(test.outbox.get(account.id)?.[0]).toMatchObject({
      phase: "FAILED",
      authoritativeStatus: "FAILED",
      canRetry: true,
    });
    expect(test.calls.fail).toBe(1);

    await test.run(
      SnippetUploadEngine.use((engine) =>
        engine.retry(account, snippetId).pipe(Effect.andThen(engine.resume(account))),
      ),
    );
    await vi.waitFor(() => expect(test.outbox.get(account.id)?.[0]?.phase).toBe("UPLOADED"));
    expect(test.calls.retry).toBe(1);
  });

  it("retries idempotent completion when its acknowledgement is lost", async () => {
    const test = harness({ completeFailures: 1 });
    await test.run(SnippetUploadEngine.use((engine) => engine.ingest(account.id, input)));

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetUploadEngine;
        yield* engine.resume(account);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
      }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer())),
    );

    await vi.waitFor(() => expect(test.outbox.get(account.id)?.[0]?.phase).toBe("UPLOADED"));
    expect(test.calls.complete).toBe(2);
    expect(test.calls.fail).toBe(0);
  });

  it("checks binary content availability without loading the file into memory", async () => {
    const test = harness();
    const fileId = "1d1e2f3a-4567-4890-8abc-def012345679";
    test.content.set(`${account.id}/${fileId}`, new Uint8Array([1, 2, 3]));
    test.outbox.set(account.id, [
      {
        id: fileId,
        fileName: "report.docx",
        byteSize: 3,
        mediaType: null,
        storageProvider: "GOOGLE_DRIVE",
        phase: "QUEUED",
        progress: 0,
        storageObjectId: null,
        authoritativeStatus: null,
        errorMessage: null,
        canRetry: false,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    const projection = await test.run(
      SnippetUploadEngine.use((engine) => engine.project(account.id, [])),
    );

    expect(projection[0]?.contentAvailable).toBe(true);
    expect(test.calls.get).toBe(0);
    expect(test.calls.available).toBe(1);
  });

  it("does not create authoritative metadata when local import times out", async () => {
    const test = harness({
      ingestFailure: new ManagedSnippetContentError({
        cause: Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" }),
        reason:
          "This file isn’t available on this Mac yet. Check its cloud download, then try again.",
      }),
    });

    await expect(
      test.run(SnippetUploadEngine.use((engine) => engine.ingest(account.id, input))),
    ).rejects.toMatchObject({
      _tag: "SnippetUploadEngineError",
      reason:
        "This file isn’t available on this Mac yet. Check its cloud download, then try again.",
    });

    expect(test.outbox.get(account.id)).toBeUndefined();
    expect(test.calls).toMatchObject({ create: 0, prepare: 0, heartbeat: 0, upload: 0 });
    expect(test.calls.discard).toBe(1);
  });

  it("interrupts importing work and cleans it before an outbox entry exists", async () => {
    const test = harness({ stallIngest: true });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetUploadEngine;
        const importing = yield* engine.ingest(account.id, input).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* engine.cancel({ id: account.id, accessToken: null }, snippetId);
        yield* Fiber.await(importing);
      }).pipe(Effect.provide(test.layer)),
    );

    expect(test.outbox.get(account.id)).toBeUndefined();
    expect(test.calls.discard).toBe(1);
    expect(test.calls.create).toBe(0);
  });

  it("extends the heartbeat deadline throughout a long provider upload", async () => {
    const test = harness({ longUpload: true });
    await test.run(SnippetUploadEngine.use((engine) => engine.ingest(account.id, input)));

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetUploadEngine;
        yield* engine.resume(account);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("41 seconds");
        yield* Effect.yieldNow;
        expect(test.calls.heartbeat).toBeGreaterThanOrEqual(3);
        expect(test.outbox.get(account.id)?.[0]?.phase).toBe("UPLOADING");
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
      }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer())),
    );

    await vi.waitFor(() => expect(test.outbox.get(account.id)?.[0]?.phase).toBe("UPLOADED"));
    expect(test.calls.complete).toBe(1);
  });

  it("bounds transient retries, keeps FAILED stable, and resumes only after explicit retry", async () => {
    const test = harness({ uploadFailures: 3 });
    await test.run(SnippetUploadEngine.use((engine) => engine.ingest(account.id, input)));

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetUploadEngine;
        yield* engine.resume(account);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("4 seconds");
        yield* Effect.yieldNow;
      }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer())),
    );

    await vi.waitFor(() => expect(test.outbox.get(account.id)?.[0]?.phase).toBe("FAILED"));
    expect(test.calls.upload).toBe(3);
    expect(test.calls.fail).toBe(1);
    expect(test.calls.complete).toBe(0);

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetUploadEngine;
        yield* engine.resume(account);
        yield* Effect.yieldNow;
        expect(test.calls.upload).toBe(3);
        yield* engine.retry(account, snippetId);
        yield* Effect.yieldNow;
      }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer())),
    );

    await vi.waitFor(() => expect(test.outbox.get(account.id)?.[0]?.phase).toBe("UPLOADED"));
    expect(test.calls.retry).toBe(1);
    expect(test.calls.upload).toBe(4);
    expect(test.calls.complete).toBe(1);
  });

  it("publishes failure but disables retry when managed bytes disappear after enqueue", async () => {
    const test = harness();
    test.outbox.set(account.id, [
      {
        id: snippetId,
        fileName: input.fileName,
        byteSize: input.byteSize,
        mediaType: input.mediaType,
        storageProvider: input.storageProvider,
        phase: "QUEUED",
        progress: 0,
        storageObjectId: null,
        authoritativeStatus: "UPLOADING",
        errorMessage: null,
        canRetry: false,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    await test.run(SnippetUploadEngine.use((engine) => engine.resume(account)));
    await vi.waitFor(() => expect(test.outbox.get(account.id)?.[0]?.phase).toBe("FAILED"));

    expect(test.outbox.get(account.id)?.[0]).toMatchObject({
      authoritativeStatus: "FAILED",
      canRetry: false,
      errorMessage: "The local copy of this snippet is unavailable.",
    });
    expect(test.calls).toMatchObject({ create: 0, prepare: 0, upload: 0, fail: 1 });
  });

  it("keeps origin-managed text available after the replica adopts the upload", async () => {
    const test = harness();
    await test.run(SnippetUploadEngine.use((engine) => engine.ingest(account.id, input)));
    await test.run(SnippetUploadEngine.use((engine) => engine.resume(account)));
    await vi.waitFor(() => expect(test.outbox.get(account.id)?.[0]?.phase).toBe("UPLOADED"));

    const replica = apiSnippet("UPLOADED");
    const projection = await test.run(
      SnippetUploadEngine.use((engine) =>
        engine
          .reconcile(account.id, [replica])
          .pipe(Effect.andThen(engine.project(account.id, [replica]))),
      ),
    );

    expect(test.outbox.get(account.id)).toEqual([]);
    expect(projection).toMatchObject([
      {
        id: snippetId,
        uploadStatus: "UPLOADED",
        localTextContent: text,
        contentAvailable: true,
      },
    ]);
  });

  it("deletes remotely when create acknowledgement may have been lost", async () => {
    const test = harness();
    test.content.set(`${account.id}/${snippetId}`, bytes);
    test.outbox.set(account.id, [
      {
        id: snippetId,
        fileName: input.fileName,
        byteSize: input.byteSize,
        mediaType: input.mediaType,
        storageProvider: input.storageProvider,
        phase: "FAILED",
        progress: 0,
        storageObjectId: null,
        authoritativeStatus: null,
        errorMessage: "Plakk could not start this upload.",
        canRetry: true,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    await test.run(SnippetUploadEngine.use((engine) => engine.delete(account, snippetId)));

    expect(test.calls.delete).toBe(1);
    expect(test.outbox.get(account.id)).toEqual([]);
    expect(test.calls.discard).toBe(1);
  });

  it("deletes never-started queued work locally while offline", async () => {
    const test = harness();
    test.content.set(`${account.id}/${snippetId}`, bytes);
    test.outbox.set(account.id, [
      {
        id: snippetId,
        fileName: input.fileName,
        byteSize: input.byteSize,
        mediaType: input.mediaType,
        storageProvider: input.storageProvider,
        phase: "QUEUED",
        progress: 0,
        storageObjectId: null,
        authoritativeStatus: null,
        errorMessage: null,
        canRetry: false,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    await test.run(
      SnippetUploadEngine.use((engine) =>
        engine.delete({ id: account.id, accessToken: null }, snippetId),
      ),
    );

    expect(test.calls.delete).toBe(0);
    expect(test.outbox.get(account.id)).toEqual([]);
  });

  it("retains uncertain upload work until authenticated deletion is possible", async () => {
    const test = harness();
    test.content.set(`${account.id}/${snippetId}`, bytes);
    test.outbox.set(account.id, [
      {
        id: snippetId,
        fileName: input.fileName,
        byteSize: input.byteSize,
        mediaType: input.mediaType,
        storageProvider: input.storageProvider,
        phase: "FAILED",
        progress: 0,
        storageObjectId: null,
        authoritativeStatus: null,
        errorMessage: "Plakk could not start this upload.",
        canRetry: true,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    await expect(
      test.run(
        SnippetUploadEngine.use((engine) =>
          engine.delete({ id: account.id, accessToken: null }, snippetId),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "SnippetUploadEngineError",
      reason: "Reconnect before deleting this snippet.",
    });

    expect(test.outbox.get(account.id)).toHaveLength(1);
    expect(test.calls.discard).toBe(0);
  });
});
