import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it } from "vite-plus/test";
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
} from "../content/ManagedSnippetContent.ts";
import { SnippetUploadEngine } from "../upload/SnippetUploadEngine.ts";
import { SnippetRemoteTransport, type SnippetSyncAccount } from "./SnippetRemoteTransport.ts";
import { SnippetReplica, SnippetReplicaError, type SnippetReplicaState } from "./SnippetReplica.ts";
import { reconcileSnippetSnapshot, runSnippetReplicaSync, syncSnippetReplica } from "./sync.ts";

const account: SnippetSyncAccount = { id: "user-1", accessToken: "token" };
const published: ApiSnippet = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "published.txt",
  byteSize: 12,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-id",
  uploadStatus: "UPLOADED",
  createdAt: "2026-07-10T20:00:00.000Z",
  updatedAt: "2026-07-10T20:00:01.000Z",
};
const local: ApiSnippet = {
  ...published,
  id: "1e2f3a4b-5678-4901-8bcd-ef0123456789",
  fileName: "local.txt",
  storageObjectId: null,
  uploadStatus: "FAILED",
};

const harness = (options: {
  initial?: SnippetReplicaState | null;
  snapshots?: ReadonlyArray<ReadonlyArray<ApiSnippet>>;
  failCommitOnce?: boolean;
  failInvalidateOnce?: boolean;
  invalidations?: Stream.Stream<void, RpcError>;
}) => {
  let state = options.initial ?? null;
  let commitFailed = false;
  let invalidationFailed = false;
  let snapshotReads = 0;
  let connections = 0;
  const invalidated: Array<ReadonlyArray<string>> = [];
  const removedPublished: Array<ReadonlyArray<string>> = [];
  const snapshots = [...(options.snapshots ?? [[]])];

  const layer = Layer.mergeAll(
    Layer.succeed(
      SnippetReplica,
      SnippetReplica.of({
        changes: Stream.empty,
        get: () => Effect.succeed(state),
        commit: (_accountId, next) =>
          Effect.suspend(() => {
            if (options.failCommitOnce === true && !commitFailed) {
              commitFailed = true;
              return Effect.fail(
                new SnippetReplicaError({ cause: null, reason: "simulated commit failure" }),
              );
            }
            state = next;
            return Effect.void;
          }),
        remove: (_accountId, snippetId) =>
          Effect.sync(() => {
            if (state !== null) {
              state = { items: state.items.filter((item) => item.id !== snippetId) };
            }
          }),
        purge: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ManagedSnippetContent,
      ManagedSnippetContent.of({
        get: () => Effect.succeed(null),
        putStream: () => Effect.void,
        available: () => Effect.succeed(false),
        invalidate: (_accountId: string, ids: ReadonlyArray<string>) =>
          Effect.suspend(() => {
            invalidated.push(ids);
            if (options.failInvalidateOnce === true && !invalidationFailed) {
              invalidationFailed = true;
              return Effect.fail(
                new ManagedSnippetContentError({
                  cause: null,
                  reason: "simulated cleanup failure",
                  retryable: true,
                }),
              );
            }
            return Effect.void;
          }),
      } as never),
    ),
    Layer.succeed(
      SnippetRemoteTransport,
      SnippetRemoteTransport.of({
        snapshot: () =>
          Effect.sync(() => {
            snapshotReads += 1;
            const next = snapshots.shift();
            if (next === undefined) {
              throw new Error("Missing scripted snapshot");
            }
            return next;
          }),
        invalidations: () =>
          Stream.unwrap(
            Effect.sync(() => {
              connections += 1;
              return options.invalidations ?? Stream.never;
            }),
          ),
      }),
    ),
    Layer.succeed(
      SnippetUploadEngine,
      SnippetUploadEngine.of({
        removePublishedRecords: (_accountId: string, ids: ReadonlyArray<string>) =>
          Effect.sync(() => {
            removedPublished.push(ids);
          }),
      } as never),
    ),
  );

  return {
    connections: () => connections,
    invalidated,
    layer,
    removedPublished,
    snapshotReads: () => snapshotReads,
    state: () => state,
  };
};

describe("snippet snapshot reconciliation", () => {
  it("replaces published records, preserves unmatched local records, and promotes a matching UUID", () => {
    const replacement = { ...published, fileName: "replacement.txt" };

    expect(reconcileSnippetSnapshot({ items: [published, local] }, [replacement])).toEqual({
      state: { items: [replacement, local] },
      stalePublishedIds: [],
    });
    expect(reconcileSnippetSnapshot({ items: [local] }, [{ ...published, id: local.id }])).toEqual({
      state: { items: [{ ...published, id: local.id }] },
      stalePublishedIds: [],
    });
  });

  it("treats absence from a successful snapshot as deletion and removes managed content", async () => {
    const test = harness({ initial: { items: [published, local] }, snapshots: [[]] });

    await Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer)));

    expect(test.state()).toEqual({ items: [local] });
    expect(test.invalidated).toEqual([[published.id]]);
    expect(test.removedPublished).toEqual([[published.id]]);
  });

  it("commits the collection before best-effort cleanup and changes nothing on commit failure", async () => {
    const cleanupFailure = harness({
      initial: { items: [published, local] },
      snapshots: [[]],
      failInvalidateOnce: true,
    });
    await Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(cleanupFailure.layer)));
    expect(cleanupFailure.state()).toEqual({ items: [local] });

    const commitFailure = harness({
      initial: { items: [published, local] },
      snapshots: [[published]],
      failCommitOnce: true,
    });
    await expect(
      Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(commitFailure.layer))),
    ).rejects.toMatchObject({ _tag: "SnippetReplicaError" });
    expect(commitFailure.state()).toEqual({ items: [published, local] });
    expect(commitFailure.invalidated).toEqual([]);
    expect(commitFailure.removedPublished).toEqual([]);
  });

  it("refreshes once for connect, reconnect, and each invalidation while publishing stream status", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Ref.make(0);
        const statuses: Array<"CONNECTED" | "RECONNECTING"> = [];
        const test = harness({
          snapshots: [[], [], []],
          invalidations: Stream.unwrap(
            Ref.getAndUpdate(attempt, (value) => value + 1).pipe(
              Effect.map((value) =>
                value === 0
                  ? Stream.make(undefined).pipe(
                      Stream.concat(
                        Stream.fail(
                          new RpcError({ code: "INTERNAL_SERVER_ERROR", message: "offline" }),
                        ),
                      ),
                    )
                  : Stream.make(undefined, undefined).pipe(Stream.concat(Stream.never)),
              ),
            ),
          ),
        });
        const fiber = yield* runSnippetReplicaSync(account, {
          onConnectionStatus: (status) =>
            Effect.sync(() => {
              statuses.push(status);
            }),
          onConnected: Effect.void,
          onDisconnected: Effect.void,
        }).pipe(Effect.provide(test.layer), Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        return {
          connections: test.connections(),
          snapshotReads: test.snapshotReads(),
          statuses,
        };
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(result.connections).toBe(2);
    expect(result.snapshotReads).toBe(3);
    expect(result.statuses).toEqual(["RECONNECTING", "CONNECTED", "RECONNECTING", "CONNECTED"]);
  });

  it("stays reconnecting and requests credential refresh when the initial snapshot fails", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const disconnected = yield* Deferred.make<void>();
        const statuses: Array<"CONNECTED" | "RECONNECTING"> = [];
        const test = harness({
          snapshots: [],
          invalidations: Stream.make(undefined).pipe(Stream.concat(Stream.never)),
        });
        const fiber = yield* runSnippetReplicaSync(account, {
          onConnectionStatus: (status) =>
            Effect.sync(() => {
              statuses.push(status);
            }),
          onConnected: Effect.void,
          onDisconnected: Deferred.succeed(disconnected, undefined),
        }).pipe(Effect.provide(test.layer), Effect.forkChild);
        yield* Deferred.await(disconnected);
        yield* Fiber.interrupt(fiber);
        return { statuses, snapshotReads: test.snapshotReads() };
      }),
    );

    expect(result.snapshotReads).toBe(1);
    expect(result.statuses).toEqual(["RECONNECTING"]);
  });
});
