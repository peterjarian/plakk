import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it } from "vite-plus/test";
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
} from "../content/ManagedSnippetContent.ts";
import { SnippetRemoteTransport, type SnippetSyncAccount } from "./SnippetRemoteTransport.ts";
import { SnippetReplica, SnippetReplicaError, type SnippetReplicaState } from "./SnippetReplica.ts";
import { runSnippetReplicaSync, syncSnippetReplica } from "./sync.ts";

const account: SnippetSyncAccount = { id: "user-1", accessToken: "token" };
const published: ApiSnippet = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "published.txt",
  byteSize: 12,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-id",
  createdAt: "2026-07-10T20:00:00.000Z",
  updatedAt: "2026-07-10T20:00:01.000Z",
};
const local = {
  kind: "LOCAL" as const,
  id: "1e2f3a4b-5678-4901-8bcd-ef0123456789",
  fileName: "local.txt",
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE" as const,
  status: "FAILED" as const,
  errorMessage: "Upload failed.",
  createdAt: "2026-07-10T21:00:00.000Z",
  updatedAt: "2026-07-10T21:00:01.000Z",
};

const harness = (options: {
  initial?: SnippetReplicaState | null;
  snapshots?: ReadonlyArray<ReadonlyArray<ApiSnippet>>;
  failUpdateOnce?: boolean;
  failInvalidateOnce?: boolean;
  invalidations?: Stream.Stream<void, RpcError>;
}) => {
  let state = options.initial ?? null;
  let updateFailed = false;
  let invalidationFailed = false;
  let snapshotReads = 0;
  let connections = 0;
  const invalidated: Array<ReadonlyArray<string>> = [];
  const snapshots = [...(options.snapshots ?? [[]])];

  const layer = Layer.mergeAll(
    Layer.succeed(
      SnippetReplica,
      SnippetReplica.of({
        changes: Stream.empty,
        get: () => Effect.succeed(state),
        commit: (_accountId, next) => Effect.sync(() => void (state = next)),
        update: (_accountId, transform) =>
          Effect.suspend(() => {
            if (options.failUpdateOnce === true && !updateFailed) {
              updateFailed = true;
              return Effect.fail(
                new SnippetReplicaError({ cause: null, reason: "simulated update failure" }),
              );
            }
            state = transform(state ?? { items: [] });
            return Effect.succeed(state);
          }),
        remove: () => Effect.void,
        purge: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ManagedSnippetContent,
      ManagedSnippetContent.of({
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
            if (next === undefined) throw new Error("Missing scripted snapshot");
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
  );

  return {
    connections: () => connections,
    invalidated,
    layer,
    snapshotReads: () => snapshotReads,
    state: () => state,
  };
};

describe("snippet snapshot synchronization", () => {
  it("commits the whole collection before best-effort deletion cleanup", async () => {
    const test = harness({
      initial: { items: [{ kind: "PUBLISHED", snippet: published }, local] },
      snapshots: [[]],
      failInvalidateOnce: true,
    });

    await Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer)));

    expect(test.state()).toEqual({ items: [local] });
    expect(test.invalidated).toEqual([[published.id]]);
  });

  it("leaves the entire collection unchanged when the atomic update fails", async () => {
    const initial = { items: [{ kind: "PUBLISHED" as const, snippet: published }, local] };
    const test = harness({ initial, snapshots: [[]], failUpdateOnce: true });

    await expect(
      Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer))),
    ).rejects.toMatchObject({ _tag: "SnippetReplicaError" });
    expect(test.state()).toEqual(initial);
    expect(test.invalidated).toEqual([]);
  });

  it("refreshes once for connect, reconnect, and each invalidation", async () => {
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

  it("stays reconnecting when the initial snapshot fails", async () => {
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
