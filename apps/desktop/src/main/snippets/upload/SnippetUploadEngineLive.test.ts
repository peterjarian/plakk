import type { ApiSnippet, PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError";

import type { SnippetIngestPayload } from "../../../ipc/contracts.ts";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
} from "../content/ManagedSnippetContent.ts";
import { SnippetReplica, type SnippetReplicaState } from "../replica/SnippetReplica.ts";
import { StorageUpload, StorageUploadError } from "./StorageUpload.ts";
import { SnippetUploadEngine, SnippetUploadEngineError } from "./SnippetUploadEngine.ts";
import { SnippetUploadEngineLive, snippetUploadFailureMessage } from "./SnippetUploadEngineLive.ts";
import {
  SnippetUploadOutbox,
  SnippetUploadOutboxError,
  type SnippetUploadOutboxEntry,
} from "./SnippetUploadOutbox.ts";
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
  readonly completeFailureType?: "transport" | "internal";
  readonly deleteFailures?: number;
  readonly deleteRpcFailure?: RpcError;
  readonly discardFailures?: number;
  readonly outboxRemoveFailures?: number;
  readonly longDelete?: boolean;
}) => {
  const outbox = new Map<string, Array<SnippetUploadOutboxEntry>>();
  const content = new Map<string, Uint8Array>();
  let replicaState: SnippetReplicaState | null = null;
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
  let remainingDeleteFailures = options?.deleteFailures ?? 0;
  let remainingDiscardFailures = options?.discardFailures ?? 0;
  let remainingOutboxRemoveFailures = options?.outboxRemoveFailures ?? 0;

  const dependencies = Layer.mergeAll(
    Layer.succeed(
      SnippetReplica,
      SnippetReplica.of({
        changes: Stream.empty,
        get: () => Effect.sync(() => replicaState),
        commit: (_accountId, state) =>
          Effect.sync(() => {
            replicaState = state;
          }),
        remove: (_accountId, snippetId) =>
          Effect.sync(() => {
            if (replicaState !== null) {
              replicaState = {
                ...replicaState,
                items: replicaState.items.filter((snippet) => snippet.id !== snippetId),
              };
            }
          }),
        purge: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ManagedSnippetContent,
      ManagedSnippetContent.of({
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
                    retryable: true,
                  }),
                );
          }),
        get: (accountId, id) =>
          Effect.sync(() => {
            calls.get += 1;
            return content.get(key(accountId, id)) ?? null;
          }),
        getPrefix: (accountId, id, maxBytes) =>
          Effect.sync(() => content.get(key(accountId, id))?.subarray(0, maxBytes) ?? null),
        validateText: () => Effect.succeed("VALID"),
        available: (accountId, id, byteSize) =>
          Effect.sync(() => {
            calls.available += 1;
            return content.get(key(accountId, id))?.byteLength === byteSize;
          }),
        putStream: () => Effect.void,
        discard: (accountId, id) =>
          Effect.gen(function* () {
            calls.discard += 1;
            if (remainingDiscardFailures > 0) {
              remainingDiscardFailures -= 1;
              return yield* new ManagedSnippetContentError({
                cause: null,
                reason: "Could not remove managed snippet content.",
                retryable: true,
              });
            }
            content.delete(key(accountId, id));
          }),
        invalidate: (accountId, ids) =>
          Effect.sync(() => {
            for (const id of ids) content.delete(key(accountId, id));
          }),
        purge: () => Effect.void,
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
          Effect.gen(function* () {
            if (remainingOutboxRemoveFailures > 0) {
              remainingOutboxRemoveFailures -= 1;
              return yield* new SnippetUploadOutboxError({
                cause: null,
                reason: "Could not save upload work.",
              });
            }
            outbox.set(
              accountId,
              accountEntries(accountId).filter((entry) => entry.id !== id),
            );
          }),
        purge: (accountId) =>
          Effect.sync(() => {
            outbox.delete(accountId);
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
              return Effect.fail(
                new RpcError({
                  code: "CONFLICT",
                  message: "The upload heartbeat expired.",
                }),
              );
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
        complete: (): Effect.Effect<ApiSnippet, RpcError | RpcClientError> =>
          Effect.suspend(() => {
            calls.complete += 1;
            if (remainingCompleteFailures > 0) {
              remainingCompleteFailures -= 1;
              const failure: RpcError | RpcClientError =
                options?.completeFailureType === "internal"
                  ? new RpcError({
                      code: "INTERNAL_SERVER_ERROR",
                      message: "The server could not acknowledge completion.",
                    })
                  : new RpcClientError({
                      reason: new RpcClientDefect({
                        cause: null,
                        message: "The completion acknowledgement was lost.",
                      }),
                    });
              return Effect.fail(failure);
            }
            return Effect.succeed(apiSnippet("UPLOADED"));
          }),
        delete: () =>
          Effect.gen(function* () {
            calls.delete += 1;
            if (options?.longDelete === true) yield* Effect.sleep("5 seconds");
            if (options?.deleteRpcFailure !== undefined) {
              return yield* Effect.fail(options.deleteRpcFailure);
            }
            if (remainingDeleteFailures > 0) {
              remainingDeleteFailures -= 1;
              return yield* new RpcClientError({
                reason: new RpcClientDefect({
                  cause: null,
                  message: "The deletion request failed in transit.",
                }),
              });
            }
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

  const layer = SnippetUploadEngineLive.pipe(Layer.provide(dependencies));
  const run = <A, E>(effect: Effect.Effect<A, E, SnippetUploadEngine>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));

  return {
    calls,
    content,
    layer,
    outbox,
    replica: {
      items: () => replicaState?.items ?? [],
      set: (items: ReadonlyArray<ApiSnippet>) => {
        replicaState = { cursor: "0", items };
      },
    },
    run,
  };
};

describe("SnippetUploadEngine", () => {
  it("keeps intentional engine failure messages at the IPC boundary", () => {
    expect(
      snippetUploadFailureMessage(
        new SnippetUploadEngineError({
          cause: null,
          reason: "This snippet is already being saved locally.",
          canRetry: false,
        }),
      ),
    ).toBe("This snippet is already being saved locally.");
  });

  it("durably queues offline, restarts with the same id, then completes", async () => {
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

  it("retries a declared transient server failure during completion", async () => {
    const test = harness({ completeFailures: 1, completeFailureType: "internal" });
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

  it("leaves managed-content availability to the local state owner", async () => {
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

    expect(projection[0]).not.toHaveProperty("localContentAvailability");
    expect(projection[0]).not.toHaveProperty("localTextPreview");
    expect(test.calls.get).toBe(0);
    expect(test.calls.available).toBe(0);
  });

  it("does not create authoritative metadata when local import times out", async () => {
    const test = harness({
      ingestFailure: new ManagedSnippetContentError({
        cause: Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" }),
        reason:
          "This file isn’t available on this Mac yet. Check its cloud download, then try again.",
        retryable: true,
      }),
    });

    await expect(
      test.run(SnippetUploadEngine.use((engine) => engine.ingest(account.id, input))),
    ).rejects.toMatchObject({
      _tag: "ManagedSnippetContentError",
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
        const projection = yield* engine.project(account.id, []);
        expect(projection).toMatchObject([
          {
            id: snippetId,
            localState: { phase: "IMPORTING" },
            importingContent: {
              localTextPreview: text,
              localContentAvailability: { status: "AVAILABLE" },
            },
          },
        ]);
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

  it("adopts the authoritative replica after upload without retaining duplicate outbox state", async () => {
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
      },
    ]);
  });

  it("does not resurrect retained failed recovery after a tombstone and restart", async () => {
    const test = harness();
    const uploadingId = "1d1e2f3a-4567-4890-8abc-def012345679";
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
        authoritativeStatus: "CLIENT_UPLOAD_FAILED",
        errorMessage: "Upload failed.",
        canRetry: true,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: uploadingId,
        fileName: "uploading.txt",
        byteSize: bytes.byteLength,
        mediaType: "text/plain",
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

    const projection = await test.run(
      SnippetUploadEngine.use((engine) =>
        engine
          .removeTombstones(account.id, [snippetId, uploadingId])
          .pipe(Effect.andThen(engine.project(account.id, []))),
      ),
    );

    expect(projection).toEqual([]);
    expect(test.outbox.get(account.id)).toEqual([]);
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

  it.effect("removes upload recovery before fallible content cleanup after remote deletion", () => {
    const test = harness({ discardFailures: 1 });
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

    return Effect.gen(function* () {
      const deleted = yield* SnippetUploadEngine.use((engine) =>
        engine.delete(account, snippetId),
      ).pipe(Effect.result);

      expect(deleted).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ManagedSnippetContentError" },
      });
      expect(test.calls.delete).toBe(1);
      expect(test.outbox.get(account.id)).toEqual([]);
      expect(test.calls.discard).toBe(1);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("keeps confirmed snippets visible while authoritative deletion is pending", () => {
    const test = harness({ longDelete: true });
    const replica = apiSnippet("UPLOADED");
    test.content.set(`${account.id}/${snippetId}`, bytes);

    return Effect.gen(function* () {
      const engine = yield* SnippetUploadEngine;
      const changed = yield* engine.changes.pipe(Stream.runHead, Effect.forkChild);
      const deleting = yield* engine.delete(account, snippetId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const whileDeleting = yield* engine.project(account.id, [replica]);
      expect(whileDeleting).toMatchObject([{ id: snippetId }]);
      expect(changed.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(deleting);

      const beforeReplicaConfirmation = yield* engine.project(account.id, [replica]);
      expect(beforeReplicaConfirmation).toMatchObject([{ id: snippetId }]);
      expect(changed.pollUnsafe()).toBeUndefined();

      expect(test.calls.delete).toBe(1);
      yield* Fiber.interrupt(changed);
    }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()));
  });

  it("waits for the ordered tombstone instead of rewriting the readable replica", async () => {
    const test = harness();
    const replica = apiSnippet("UPLOADED");
    test.replica.set([replica]);
    test.content.set(`${account.id}/${snippetId}`, bytes);

    await test.run(SnippetUploadEngine.use((engine) => engine.delete(account, snippetId)));

    expect(test.replica.items()).toEqual([replica]);
    const afterRestart = await test.run(
      SnippetUploadEngine.use((engine) => engine.project(account.id, test.replica.items())),
    );
    expect(afterRestart).toMatchObject([{ id: snippetId }]);
  });

  it("restores an optimistically hidden snippet when deletion fails", async () => {
    const test = harness({ deleteFailures: 1 });
    const replica = apiSnippet("UPLOADED");
    test.content.set(`${account.id}/${snippetId}`, bytes);

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetUploadEngine;
        const deleted = yield* Effect.exit(engine.delete(account, snippetId));
        expect(deleted._tag).toBe("Failure");

        const restored = yield* engine.project(account.id, [replica]);
        expect(restored).toHaveLength(1);
        expect(restored[0]?.id).toBe(snippetId);
      }).pipe(Effect.provide(test.layer)),
    );
  });

  it("preserves a declared remote error until the caller boundary", async () => {
    const test = harness({
      deleteRpcFailure: new RpcError({
        code: "CONFLICT",
        message: "sensitive provider deletion detail",
      }),
    });

    await expect(
      test.run(SnippetUploadEngine.use((engine) => engine.delete(account, snippetId))),
    ).rejects.toMatchObject({
      _tag: "RpcError",
      message: "sensitive provider deletion detail",
    });
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
