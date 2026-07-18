import { describe, expect, it } from "vite-plus/test";
import { Effect, Fiber, Layer, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { ApiSnippet, SnippetChangePage } from "./api/PlakkApi.ts";
import { RpcError } from "./api/RpcError.ts";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
  SnippetRemoteTransport,
  SnippetReplica,
  SnippetReplicaError,
  runSnippetReplicaSync,
  syncSnippetReplica,
  type SnippetReplicaState,
  type SnippetSyncAccount,
} from "./SnippetReplica.ts";

const account: SnippetSyncAccount = { id: "user-1", accessToken: "token" };
const snippet: ApiSnippet = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "0d1e2f3a-4567-4890-8abc-def012345678.txt",
  byteSize: 12,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-id",
  uploadStatus: "UPLOADED",
  createdAt: "2026-07-10T20:00:00.000Z",
  updatedAt: "2026-07-10T20:00:01.000Z",
};

const harness = (options: {
  initial?: SnippetReplicaState | null;
  pages?: ReadonlyArray<SnippetChangePage>;
  snapshot?: SnippetReplicaState;
  failCommitOnce?: boolean;
  failInvalidateOnce?: boolean;
  wakes?: Stream.Stream<void, RpcError>;
}) => {
  let state = options.initial ?? null;
  let failed = false;
  let invalidationFailed = false;
  let pulls = 0;
  let connections = 0;
  const invalidated: Array<ReadonlyArray<string>> = [];
  const statesAtInvalidation: Array<SnippetReplicaState | null> = [];
  const pages = [...(options.pages ?? [])];
  const snapshot = options.snapshot ?? { cursor: "snapshot", items: [] };

  const layer = Layer.mergeAll(
    Layer.succeed(
      SnippetReplica,
      SnippetReplica.of({
        changes: Stream.empty,
        get: () => Effect.succeed(state),
        commit: (_accountId, next) =>
          Effect.suspend(() => {
            if (options.failCommitOnce === true && !failed) {
              failed = true;
              return Effect.fail(
                new SnippetReplicaError({ cause: null, reason: "simulated crash" }),
              );
            }
            state = next;
            return Effect.void;
          }),
        remove: (_accountId, snippetId) =>
          Effect.sync(() => {
            if (state !== null) {
              state = { ...state, items: state.items.filter((item) => item.id !== snippetId) };
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
        invalidate: (_accountId, ids) =>
          Effect.suspend(() => {
            invalidated.push(ids);
            statesAtInvalidation.push(state);
            if (options.failInvalidateOnce === true && !invalidationFailed) {
              invalidationFailed = true;
              return Effect.fail(
                new ManagedSnippetContentError({
                  cause: null,
                  reason: "simulated cleanup crash",
                  retryable: true,
                }),
              );
            }
            return Effect.void;
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
    statesAtInvalidation,
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

  it("invalidates managed content only when the snippet is deleted", async () => {
    const test = harness({
      initial: { cursor: "old", items: [snippet] },
      pages: [
        {
          status: "OK",
          changes: [{ type: "DELETE", snippetId: snippet.id }],
          nextCursor: "next",
        },
      ],
    });

    await Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer)));

    expect(test.state()).toEqual({ cursor: "next", items: [] });
    expect(test.invalidated).toEqual([[snippet.id]]);
    expect(test.statesAtInvalidation).toEqual([{ cursor: "old", items: [snippet] }]);
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

  it("does not advance a tombstone cursor until managed content cleanup succeeds", async () => {
    const page = {
      status: "OK",
      changes: [{ type: "DELETE", snippetId: snippet.id }],
      nextCursor: "next",
    } as const;
    const test = harness({
      initial: { cursor: "old", items: [snippet] },
      pages: [page, page],
      failInvalidateOnce: true,
    });

    await expect(
      Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer))),
    ).rejects.toMatchObject({ _tag: "ManagedSnippetContentError" });
    expect(test.state()).toEqual({ cursor: "old", items: [snippet] });

    await Effect.runPromise(syncSnippetReplica(account).pipe(Effect.provide(test.layer)));
    expect(test.state()).toEqual({ cursor: "next", items: [] });
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
});
