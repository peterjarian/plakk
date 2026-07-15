import { describe, expect, it } from "vite-plus/test";
import { Effect, Fiber, Layer, Ref, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { ApiSnippet, SnippetChangePage } from "./api/PlakkApi.ts";
import { RpcError } from "./api/RpcError.ts";
import {
  enqueueTextSnippet,
  ManagedSnippetContent,
  processTextSnippetOutbox,
  retryTextSnippet,
  SnippetRemoteTransport,
  SnippetReplica,
  SnippetReplicaError,
  SnippetReplicaStateSchema,
  TextSnippetUploadError,
  TextSnippetUploadTransport,
  runSnippetReplicaSync,
  syncSnippetReplica,
  visibleSnippetItems,
  type SnippetReplicaState,
  type SnippetSyncAccount,
} from "./SnippetReplica.ts";

const account: SnippetSyncAccount = { id: "user-1", accessToken: "token" };
const snippet: ApiSnippet = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  kind: "TEXT",
  title: "Text snippet",
  fileName: "0d1e2f3a-4567-4890-8abc-def012345678.txt",
  byteSize: 12,
  contentType: "text/plain; charset=utf-8",
  contentUrl: null,
  thumbnailUrl: null,
  textContent: null,
  storageProvider: "GOOGLE_DRIVE",
  uploadStatus: "READY",
  createdAt: "2026-07-10T20:00:00.000Z",
  updatedAt: "2026-07-10T20:00:01.000Z",
};

const harness = (options: {
  initial?: SnippetReplicaState | null;
  pages?: ReadonlyArray<SnippetChangePage>;
  snapshot?: SnippetReplicaState;
  failCommitOnce?: boolean;
  wakes?: Stream.Stream<void, RpcError>;
  beforeModify?: (state: SnippetReplicaState | null) => SnippetReplicaState | null;
}) => {
  let state = options.initial ?? null;
  let failed = false;
  let pulls = 0;
  let connections = 0;
  let beforeModify = options.beforeModify;
  const invalidated: Array<ReadonlyArray<string>> = [];
  const removedRevisions: Array<{ snippetId: string; revision: string }> = [];
  const pages = [...(options.pages ?? [])];
  const snapshot = options.snapshot ?? { cursor: "snapshot", items: [] };

  const layer = Layer.mergeAll(
    Layer.succeed(
      SnippetReplica,
      SnippetReplica.of({
        changes: Stream.empty,
        get: () => Effect.succeed(state),
        modify: (_accountId, update) =>
          Effect.suspend(() => {
            if (options.failCommitOnce === true && !failed) {
              failed = true;
              return Effect.fail(
                new SnippetReplicaError({ cause: null, reason: "simulated crash" }),
              );
            }
            if (beforeModify !== undefined) {
              state = beforeModify(state);
              beforeModify = undefined;
            }
            state = update(state);
            return Effect.succeed(state);
          }),
      }),
    ),
    Layer.succeed(
      ManagedSnippetContent,
      ManagedSnippetContent.of({
        get: () => Effect.succeed(null),
        put: () => Effect.void,
        removeRevision: (_accountId, snippetId, revision) =>
          Effect.sync(() => void removedRevisions.push({ snippetId, revision })),
        invalidate: (_accountId, ids) =>
          Effect.sync(() => {
            invalidated.push(ids);
          }),
      }),
    ),
    Layer.succeed(
      SnippetRemoteTransport,
      SnippetRemoteTransport.of({
        pull: () =>
          Effect.sync(() => {
            pulls += 1;
            return pages.shift() ?? { status: "OK", changes: [], nextCursor: state?.cursor ?? "" };
          }),
        snapshot: () => Effect.succeed(snapshot),
        wakes: () =>
          Stream.unwrap(
            Effect.sync(() => {
              connections += 1;
              return options.wakes ?? Stream.never;
            }),
          ),
      }),
    ),
  );

  return {
    invalidated,
    removedRevisions,
    layer,
    state: () => state,
    pulls: () => pulls,
    connections: () => connections,
  };
};

describe("snippet replica synchronization", () => {
  it("replays an upsert without duplicating metadata", async () => {
    const page = {
      status: "OK",
      changes: [{ type: "UPSERT", snippet }],
      nextCursor: "next",
    } as const;
    const test = harness({
      initial: { cursor: "old", items: [snippet] },
      pages: [page, { ...page, changes: [] }],
    });

    await Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer)));

    expect(test.state()).toEqual({ cursor: "next", items: [snippet] });
    expect(test.invalidated).toEqual([]);
  });

  it("re-pulls the same page after a crash before the cursor commit", async () => {
    const page = {
      status: "OK",
      changes: [{ type: "UPSERT", snippet }],
      nextCursor: "next",
    } as const;
    const test = harness({
      initial: { cursor: "old", items: [] },
      pages: [page, page],
      failCommitOnce: true,
    });

    await expect(
      Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer))),
    ).rejects.toMatchObject({ _tag: "SnippetReplicaError" });
    expect(test.state()).toEqual({ cursor: "old", items: [] });

    await Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer)));
    expect(test.state()).toEqual({ cursor: "next", items: [snippet] });
  });

  it("reconnects the wake stream and synchronizes after connectivity returns", async () => {
    const attempts = await Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Ref.make(0);
        const test = harness({
          initial: { cursor: "cursor", items: [] },
          wakes: Stream.unwrap(
            Ref.getAndUpdate(attempt, (value) => value + 1).pipe(
              Effect.map((value) =>
                value === 0
                  ? Stream.fail(new RpcError({ code: "INTERNAL_SERVER_ERROR", message: "offline" }))
                  : Stream.make(undefined),
              ),
            ),
          ),
        });
        const fiber = yield* runSnippetReplicaSync(account).pipe(
          Effect.provide(test.layer),
          Effect.forkChild,
        );
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        return { connections: test.connections(), pulls: test.pulls() };
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(attempts.connections).toBeGreaterThanOrEqual(2);
    expect(attempts.pulls).toBeGreaterThanOrEqual(2);
  });

  it("replaces a stale cursor with a fresh snapshot", async () => {
    const fresh = { cursor: "fresh", items: [snippet] };
    const test = harness({
      initial: { cursor: "stale", items: [] },
      pages: [{ status: "RESNAPSHOT_REQUIRED" }],
      snapshot: fresh,
    });

    await Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer)));

    expect(test.state()).toEqual(fresh);
  });

  it("preserves a concurrently enqueued text mutation while committing remote changes", async () => {
    const queued = {
      mutationId: "1d1e2f3a-4567-4890-8abc-def012345678",
      snippetId: "2d1e2f3a-4567-4890-8abc-def012345678",
      byteSize: 12,
      storageProvider: null,
      createdAt: "2026-07-15T08:00:00.000Z",
      status: "QUEUED" as const,
      errorMessage: null,
    };
    const test = harness({
      initial: { cursor: "old", items: [] },
      pages: [{ status: "OK", changes: [{ type: "UPSERT", snippet }], nextCursor: "next" }],
      beforeModify: (state) => ({ ...state!, textOutbox: [queued] }),
    });

    await Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer)));

    expect(test.state()).toEqual({ cursor: "next", items: [snippet], textOutbox: [queued] });
  });

  it("preserves the queued content revision when authoritative UPLOADING arrives", async () => {
    const queued = {
      mutationId: "1d1e2f3a-4567-4890-8abc-def012345678",
      snippetId: snippet.id,
      byteSize: snippet.byteSize,
      storageProvider: "GOOGLE_DRIVE" as const,
      createdAt: snippet.createdAt,
      status: "QUEUED" as const,
      errorMessage: null,
    };
    const uploading = { ...snippet, uploadStatus: "UPLOADING" as const };
    const test = harness({
      initial: { cursor: "before-create", items: [], textOutbox: [queued] },
      pages: [
        {
          status: "OK",
          changes: [{ type: "UPSERT", snippet: uploading }],
          nextCursor: "after-create",
        },
      ],
    });

    await Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer)));

    expect(test.invalidated).toEqual([]);
    expect(test.removedRevisions).toEqual([]);
    expect(test.state()?.textOutbox).toEqual([queued]);
  });
});

describe("text snippet outbox", () => {
  const queued = {
    mutationId: "1d1e2f3a-4567-4890-8abc-def012345678",
    snippetId: "2d1e2f3a-4567-4890-8abc-def012345678",
    byteSize: 12,
    storageProvider: null,
    createdAt: "2026-07-15T08:00:00.000Z",
    status: "QUEUED" as const,
    errorMessage: null,
  };

  const outboxHarness = (
    initial: SnippetReplicaState | null = null,
    firstCreateError: TextSnippetUploadError | null = new TextSnippetUploadError({
      actionable: false,
      message: "offline",
    }),
    firstCompleteError: TextSnippetUploadError | null = null,
    firstUploadError: TextSnippetUploadError | null = null,
  ) => {
    let state = initial;
    const bytesByRevision = new Map<string, Uint8Array>();
    const calls: Array<string> = [];
    let createAttempts = 0;
    let completeAttempts = 0;
    let uploadAttempts = 0;
    const layer = Layer.mergeAll(
      Layer.succeed(
        SnippetReplica,
        SnippetReplica.of({
          changes: Stream.empty,
          get: () => Effect.succeed(state),
          modify: (_accountId, update) =>
            Effect.sync(() => {
              state = update(state);
              return state;
            }),
        }),
      ),
      Layer.succeed(
        ManagedSnippetContent,
        ManagedSnippetContent.of({
          get: (_accountId, snippetId, revision) =>
            Effect.succeed(bytesByRevision.get(`${snippetId}:${revision}`) ?? null),
          put: (_accountId, snippetId, revision, bytes) =>
            Effect.sync(() => void bytesByRevision.set(`${snippetId}:${revision}`, bytes)),
          removeRevision: (_accountId, snippetId, revision) =>
            Effect.sync(() => void bytesByRevision.delete(`${snippetId}:${revision}`)),
          invalidate: () => Effect.void,
        }),
      ),
      Layer.succeed(
        TextSnippetUploadTransport,
        TextSnippetUploadTransport.of({
          resolveStorageProvider: () => Effect.succeed("GOOGLE_DRIVE"),
          create: () =>
            Effect.sync(() => {
              calls.push("create");
              createAttempts += 1;
            }).pipe(
              Effect.flatMap(() =>
                createAttempts === 1 && firstCreateError !== null
                  ? Effect.fail(firstCreateError)
                  : Effect.succeed({
                      ...snippet,
                      id: queued.snippetId,
                      uploadStatus: "UPLOADING" as const,
                    }),
              ),
            ),
          prepare: () =>
            Effect.sync(() => {
              calls.push("prepare");
              return {
                storageProvider: "GOOGLE_DRIVE" as const,
                storageObjectId: "drive-id",
                upload: {
                  method: "PUT" as const,
                  url: "https://upload.example",
                  headers: [],
                  strategy: { type: "single_request" as const },
                },
                expiresAt: null,
                preparationGeneration: 1,
              };
            }),
          heartbeat: () => Effect.sync(() => void calls.push("heartbeat")),
          upload: (_item, bytes) =>
            Effect.sync(() => {
              calls.push(`upload:${new TextDecoder().decode(bytes)}`);
              uploadAttempts += 1;
              return "drive-id";
            }).pipe(
              Effect.flatMap((storageObjectId) =>
                uploadAttempts === 1 && firstUploadError !== null
                  ? Effect.fail(firstUploadError)
                  : Effect.succeed(storageObjectId),
              ),
            ),
          complete: () =>
            Effect.sync(() => {
              calls.push("complete");
              completeAttempts += 1;
              return {
                ...snippet,
                id: queued.snippetId,
                updatedAt: "2026-07-15T08:00:01.000Z",
              };
            }).pipe(
              Effect.flatMap((completed) =>
                completeAttempts === 1 && firstCompleteError !== null
                  ? Effect.fail(firstCompleteError)
                  : Effect.succeed(completed),
              ),
            ),
          fail: () => Effect.sync(() => void calls.push("fail")),
        }),
      ),
    );
    return { bytesByRevision, calls, layer, state: () => state };
  };

  it("stores managed bytes and the durable mutation before reporting queued", async () => {
    const test = outboxHarness({ cursor: "cursor", items: [], textOutbox: [] });
    const bytes = new TextEncoder().encode("hello world!");

    const item = await Effect.runPromise(
      enqueueTextSnippet("user-1", queued, bytes).pipe(Effect.provide(test.layer)),
    );

    expect(item).toEqual(queued);
    expect(test.bytesByRevision.get(`${queued.snippetId}:${queued.mutationId}`)).toEqual(bytes);
    expect(test.state()?.textOutbox).toEqual([queued]);
  });

  it("recovers after restart and replays create idempotently through completion", async () => {
    const bytes = new TextEncoder().encode("hello world!");
    const initial = { cursor: "cursor", items: [], textOutbox: [queued] };
    const test = outboxHarness(initial);
    test.bytesByRevision.set(`${queued.snippetId}:${queued.mutationId}`, bytes);
    const account = { id: "user-1", accessToken: "token" };

    await Effect.runPromise(processTextSnippetOutbox(account).pipe(Effect.provide(test.layer)));
    expect(test.state()?.textOutbox).toEqual([{ ...queued, storageProvider: "GOOGLE_DRIVE" }]);

    await Effect.runPromise(processTextSnippetOutbox(account).pipe(Effect.provide(test.layer)));
    expect(test.calls).toEqual([
      "create",
      "create",
      "prepare",
      "heartbeat",
      "upload:hello world!",
      "complete",
    ]);
    expect(test.state()?.textOutbox).toEqual([]);
    expect(test.state()?.items).toEqual([
      { ...snippet, id: queued.snippetId, updatedAt: "2026-07-15T08:00:01.000Z" },
    ]);
    expect(test.bytesByRevision.get(`${queued.snippetId}:2026-07-15T08:00:01.000Z`)).toEqual(bytes);
  });

  it("keeps network loss queued instead of turning it into an actionable failure", async () => {
    const test = outboxHarness({ cursor: "cursor", items: [], textOutbox: [queued] });
    test.bytesByRevision.set(
      `${queued.snippetId}:${queued.mutationId}`,
      new TextEncoder().encode("hello world!"),
    );

    await Effect.runPromise(
      processTextSnippetOutbox({ id: "user-1", accessToken: "token" }).pipe(
        Effect.provide(test.layer),
      ),
    );

    expect(test.state()?.textOutbox).toEqual([{ ...queued, storageProvider: "GOOGLE_DRIVE" }]);
    expect(test.calls).toEqual(["create"]);
  });

  it("retries lost finalization without uploading provider bytes twice", async () => {
    const bytes = new TextEncoder().encode("hello world!");
    const test = outboxHarness(
      { cursor: "cursor", items: [], textOutbox: [queued] },
      null,
      new TextSnippetUploadError({ actionable: false, message: "offline after upload" }),
    );
    test.bytesByRevision.set(`${queued.snippetId}:${queued.mutationId}`, bytes);

    await Effect.runPromise(processTextSnippetOutbox(account).pipe(Effect.provide(test.layer)));
    expect(test.state()?.textOutbox?.[0]).toMatchObject({ storageObjectId: "drive-id" });

    await Effect.runPromise(processTextSnippetOutbox(account).pipe(Effect.provide(test.layer)));

    expect(test.calls.filter((call) => call.startsWith("upload:"))).toHaveLength(1);
    expect(test.calls.filter((call) => call === "complete")).toHaveLength(2);
    expect(test.state()?.textOutbox).toEqual([]);
  });

  it("requests a fresh preparation after a provider rejects a stale session", async () => {
    const bytes = new TextEncoder().encode("hello world!");
    const test = outboxHarness(
      { cursor: "cursor", items: [], textOutbox: [queued] },
      null,
      null,
      new TextSnippetUploadError({
        actionable: false,
        message: "Upload session expired.",
        stalePreparation: true,
      }),
    );
    test.bytesByRevision.set(`${queued.snippetId}:${queued.mutationId}`, bytes);

    await Effect.runPromise(processTextSnippetOutbox(account).pipe(Effect.provide(test.layer)));
    expect(test.state()?.textOutbox?.[0]).toMatchObject({
      replacePreparationGeneration: 1,
    });

    await Effect.runPromise(processTextSnippetOutbox(account).pipe(Effect.provide(test.layer)));
    expect(test.state()?.textOutbox).toEqual([]);
    expect(test.calls.filter((call) => call === "prepare")).toHaveLength(2);
  });

  it("persists actionable failure and allows an explicit retry", async () => {
    const test = outboxHarness(
      { cursor: "cursor", items: [], textOutbox: [queued] },
      new TextSnippetUploadError({ actionable: true, message: "Reconnect storage." }),
    );
    test.bytesByRevision.set(
      `${queued.snippetId}:${queued.mutationId}`,
      new TextEncoder().encode("hello world!"),
    );

    await Effect.runPromise(
      processTextSnippetOutbox({ id: "user-1", accessToken: "token" }).pipe(
        Effect.provide(test.layer),
      ),
    );
    expect(test.state()?.textOutbox).toEqual([
      {
        ...queued,
        storageProvider: "GOOGLE_DRIVE",
        status: "NEEDS_ACTION",
        errorMessage: "Reconnect storage.",
      },
    ]);
    expect(test.calls).toEqual(["create", "fail"]);

    await Effect.runPromise(processTextSnippetOutbox(account).pipe(Effect.provide(test.layer)));
    expect(test.calls).toEqual(["create", "fail", "fail"]);

    await Effect.runPromise(
      retryTextSnippet("user-1", queued.snippetId).pipe(Effect.provide(test.layer)),
    );
    expect(test.state()?.textOutbox?.[0]).toMatchObject({
      status: "QUEUED",
      errorMessage: null,
    });
  });

  it("decodes pre-outbox replica state after an app upgrade", async () => {
    await expect(
      Schema.decodePromise(SnippetReplicaStateSchema)({ cursor: "legacy", items: [snippet] }),
    ).resolves.toEqual({ cursor: "legacy", items: [snippet] });
  });

  it("replaces local QUEUED presentation with authoritative UPLOADING state", () => {
    const uploading = {
      ...snippet,
      id: queued.snippetId,
      uploadStatus: "UPLOADING" as const,
    };

    expect(
      visibleSnippetItems({ cursor: "cursor", items: [uploading], textOutbox: [queued] }),
    ).toEqual([uploading]);
  });
});
