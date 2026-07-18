import { NodeFileSystem } from "@effect/platform-node";
import type { User } from "@plakk/shared";
import type { ApiSnippet, SnippetChangePage } from "@plakk/shared/PlakkApi";
import { SnippetHydrationEngine } from "./Services/SnippetHydration.ts";
import {
  ManagedSnippetContent,
  runSnippetReplicaSync,
  SnippetRemoteTransport,
  SnippetReplica,
  syncSnippetReplica,
  type SnippetReplicaState,
} from "@plakk/shared/SnippetReplica";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, ManagedRuntime, Option, PubSub, Stream } from "effect";

import { LocalStateLive } from "./Layers/LocalState.ts";
import { LocalStateSnippetsLive } from "./Layers/LocalStateSnippets.ts";
import { makeLocalStateStoreLive } from "./Layers/LocalStateStore.ts";
import { SnippetReplicaWithUploadCleanupLive } from "./Layers/SnippetReplica.ts";
import { LocalState } from "./Services/LocalState.ts";
import { DesktopManagedSnippetContent } from "./ManagedSnippetContent.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";
import { SnippetUploadOutboxError } from "./SnippetUploadOutbox.ts";

const user: User = {
  id: "user_1",
  email: "user_1@example.com",
  firstName: "Desktop",
  lastName: "Reader",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const syncAccount = { id: user.id, accessToken: "token" };
const snippet = (
  id: string,
  fileName: string,
  uploadStatus: ApiSnippet["uploadStatus"] = "UPLOADED",
): ApiSnippet => ({
  id,
  fileName,
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: `provider-${id}`,
  uploadStatus,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const harness = (options: {
  initial?: SnippetReplicaState | null;
  pages?: Array<SnippetChangePage>;
  snapshot?: SnippetReplicaState;
  failTombstoneCleanupOnce?: boolean;
  wakes?: Stream.Stream<void>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-sync-" });
    let state = options.initial ?? null;
    const snapshot = options.snapshot ?? { cursor: "snapshot", items: [] };
    const pages = options.pages ?? [];
    const tombstoneCleanups: Array<ReadonlyArray<string>> = [];
    let tombstoneCleanupFailed = false;
    const replicaChanges = yield* PubSub.unbounded<{
      readonly accountId: string;
      readonly items: ReadonlyArray<ApiSnippet>;
    }>();
    const replica = SnippetReplica.of({
      changes: Stream.fromPubSub(replicaChanges),
      get: () => Effect.succeed(state),
      commit: (accountId, next) =>
        Effect.sync(() => void (state = next)).pipe(
          Effect.andThen(PubSub.publish(replicaChanges, { accountId, items: next.items })),
          Effect.asVoid,
        ),
      purge: (accountId) =>
        Effect.sync(() => void (state = null)).pipe(
          Effect.andThen(PubSub.publish(replicaChanges, { accountId, items: [] })),
          Effect.asVoid,
        ),
      remove: (accountId, id) =>
        Effect.sync(() => {
          if (state !== null)
            state = { ...state, items: state.items.filter((item) => item.id !== id) };
        }).pipe(
          Effect.andThen(PubSub.publish(replicaChanges, { accountId, items: state?.items ?? [] })),
          Effect.asVoid,
        ),
    });
    const remote = SnippetRemoteTransport.of({
      pull: () =>
        Effect.sync(
          () => pages.shift() ?? { status: "OK", changes: [], nextCursor: state?.cursor ?? "" },
        ),
      snapshot: () => Effect.sync(() => snapshot),
      wakes: () => options.wakes ?? Stream.never,
    });
    const managed = ManagedSnippetContent.of({
      available: () => Effect.succeed(false),
      get: () => Effect.succeed(null),
      invalidate: () => Effect.void,
      putStream: () => Effect.void,
    });
    const uploads = SnippetUploadEngine.of({
      cancel: () => Effect.void,
      changes: Stream.empty,
      delete: () => Effect.void,
      discard: () => Effect.void,
      ingest: () => Effect.void,
      pause: Effect.void,
      project: (_accountId, items) =>
        Effect.succeed(items.map((item) => ({ ...item, localState: null }))),
      purge: () => Effect.void,
      reconcile: () => Effect.void,
      removeTombstones: (_accountId, snippetIds) =>
        Effect.suspend(() => {
          tombstoneCleanups.push(snippetIds);
          if (options.failTombstoneCleanupOnce === true && !tombstoneCleanupFailed) {
            tombstoneCleanupFailed = true;
            return Effect.fail(
              new SnippetUploadOutboxError({
                cause: null,
                reason: "simulated device-local cleanup failure",
              }),
            );
          }
          return Effect.void;
        }),
      resume: () => Effect.void,
      retry: () => Effect.void,
    });
    const hydration = SnippetHydrationEngine.of({
      changes: Stream.empty,
      download: () => Effect.void,
      pause: Effect.void,
      purge: () => Effect.void,
      reconcile: () =>
        Effect.succeed(
          new Map(
            (state?.items ?? []).map((item) => [item.id, { status: "NOT_AVAILABLE" } as const]),
          ),
        ),
      resume: () => Effect.void,
      state: () => Effect.succeed({ status: "NOT_AVAILABLE" }),
    });
    const desktopContent = DesktopManagedSnippetContent.of({
      available: () => Effect.succeed(false),
      discard: () => Effect.void,
      get: () => Effect.succeed(null),
      getPrefix: () => Effect.succeed(null),
      ingest: () => Effect.succeed("/managed/content"),
      invalidate: () => Effect.void,
      path: () => Effect.succeed("/managed/content"),
      purge: () => Effect.void,
      putStream: () => Effect.void,
      validateText: () => Effect.succeed("NOT_FOUND"),
    });
    const uploadsLayer = Layer.succeed(SnippetUploadEngine, uploads);
    const replicaLayer = SnippetReplicaWithUploadCleanupLive.pipe(
      Layer.provide(Layer.merge(Layer.succeed(SnippetReplica, replica), uploadsLayer)),
    );
    const localStateSnippets = LocalStateSnippetsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          replicaLayer,
          uploadsLayer,
          Layer.succeed(SnippetHydrationEngine, hydration),
          Layer.succeed(DesktopManagedSnippetContent, desktopContent),
        ),
      ),
    );
    const syncLayer = Layer.mergeAll(
      replicaLayer,
      Layer.succeed(SnippetRemoteTransport, remote),
      Layer.succeed(ManagedSnippetContent, managed),
    );
    const runtime = ManagedRuntime.make(
      Layer.merge(
        LocalStateLive.pipe(
          Layer.provide(Layer.merge(makeLocalStateStoreLive({ cwd }), localStateSnippets)),
        ),
        syncLayer,
      ),
    );
    return {
      currentState: () => state,
      runtime,
      tombstoneCleanups,
    };
  });

it.layer(NodeFileSystem.layer)("local state synchronization seam", (it) => {
  it.effect("publishes authoritative upload failures through replica changes", () =>
    Effect.gen(function* () {
      const first = snippet(
        "0d1e2f3a-4567-4890-8abc-def012345678",
        "first.txt",
        "CLIENT_UPLOAD_FAILED",
      );
      const test = yield* harness({ snapshot: { cursor: "snapshot", items: [first] } });
      yield* Effect.promise(() =>
        test.runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "offline", account: user })),
        ),
      );

      const snapshotLocalState = yield* Effect.promise(() =>
        test.runtime.runPromise(
          Effect.gen(function* () {
            const localState = yield* LocalState;
            const changed = yield* localState.changes.pipe(
              Stream.filter((value) => value.snippets.some((item) => item.id === first.id)),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            const sync = yield* syncSnippetReplica(syncAccount).pipe(Effect.forkChild);
            const value = yield* Fiber.join(changed);
            yield* Fiber.join(sync);
            return value;
          }),
        ),
      );
      expect(snapshotLocalState.snippets).toMatchObject([
        { id: first.id, uploadStatus: "CLIENT_UPLOAD_FAILED" },
      ]);
      yield* Effect.promise(() => test.runtime.dispose());
    }),
  );

  it.effect("publishes pull tombstones through replica changes", () =>
    Effect.gen(function* () {
      const first = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "first.txt");
      const pull = yield* harness({
        initial: { cursor: "snapshot", items: [first] },
        pages: [
          {
            status: "OK",
            changes: [{ type: "DELETE", snippetId: first.id }],
            nextCursor: "pulled",
          },
        ],
      });
      yield* Effect.promise(() =>
        pull.runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "offline", account: user })),
        ),
      );
      const pulledLocalState = yield* Effect.promise(() =>
        pull.runtime.runPromise(
          Effect.gen(function* () {
            const localState = yield* LocalState;
            const changed = yield* localState.changes.pipe(
              Stream.filter((value) => value.snippets.length === 0),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            const sync = yield* syncSnippetReplica(syncAccount).pipe(Effect.forkChild);
            const value = yield* Fiber.join(changed);
            yield* Fiber.join(sync);
            return value;
          }),
        ),
      );
      expect(pull.currentState()).toEqual({ cursor: "pulled", items: [] });
      expect(pull.tombstoneCleanups).toEqual([[first.id]]);
      expect(pulledLocalState).toMatchObject({ snippets: [] });
      yield* Effect.promise(() => pull.runtime.dispose());
    }),
  );

  it.effect("retries device-local tombstone cleanup before advancing the cursor", () =>
    Effect.gen(function* () {
      const first = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "first.txt");
      const page = {
        status: "OK",
        changes: [{ type: "DELETE", snippetId: first.id }],
        nextCursor: "pulled",
      } as const;
      const test = yield* harness({
        initial: { cursor: "snapshot", items: [first] },
        pages: [page, page],
        failTombstoneCleanupOnce: true,
      });

      const firstSync = yield* Effect.promise(() =>
        test.runtime.runPromise(syncSnippetReplica(syncAccount).pipe(Effect.result)),
      );
      expect(firstSync._tag).toBe("Failure");
      expect(test.currentState()).toEqual({ cursor: "snapshot", items: [first] });

      yield* Effect.promise(() => test.runtime.runPromise(syncSnippetReplica(syncAccount)));
      expect(test.currentState()).toEqual({ cursor: "pulled", items: [] });
      expect(test.tombstoneCleanups).toEqual([[first.id], [first.id]]);
      yield* Effect.promise(() => test.runtime.dispose());
    }),
  );

  it.effect("publishes required resnapshots through replica changes", () =>
    Effect.gen(function* () {
      const second = snippet("1d1e2f3a-4567-4890-8abc-def012345679", "second.txt");
      const resnapshot = yield* harness({
        initial: { cursor: "pulled", items: [] },
        pages: [{ status: "RESNAPSHOT_REQUIRED" }],
        snapshot: { cursor: "fresh", items: [second] },
      });
      yield* Effect.promise(() =>
        resnapshot.runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "offline", account: user })),
        ),
      );
      const materialized = yield* Effect.promise(() =>
        resnapshot.runtime.runPromise(
          Effect.gen(function* () {
            const localState = yield* LocalState;
            const changed = yield* localState.changes.pipe(
              Stream.filter((value) => value.snippets.some((item) => item.id === second.id)),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            const sync = yield* syncSnippetReplica(syncAccount).pipe(Effect.forkChild);
            const value = yield* Fiber.join(changed);
            yield* Fiber.join(sync);
            return value;
          }),
        ),
      );
      yield* Effect.promise(() => resnapshot.runtime.dispose());

      expect(resnapshot.currentState()).toEqual({ cursor: "fresh", items: [second] });
      expect(materialized.snippets).toMatchObject([{ id: second.id }]);
      expect(materialized.snippets[0]).not.toHaveProperty("storageObjectId");
    }),
  );

  it.effect("projects a pull triggered by the desktop wake stream", () =>
    Effect.gen(function* () {
      const awakened = snippet("2d1e2f3a-4567-4890-8abc-def012345670", "awakened.txt");
      const test = yield* harness({
        initial: { cursor: "old", items: [] },
        pages: [
          { status: "OK", changes: [], nextCursor: "old" },
          { status: "OK", changes: [{ type: "UPSERT", snippet: awakened }], nextCursor: "wake" },
        ],
        wakes: Stream.make(undefined),
      });
      yield* Effect.promise(() =>
        test.runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "offline", account: user })),
        ),
      );
      const materialized = yield* Effect.promise(() =>
        test.runtime.runPromise(
          Effect.gen(function* () {
            const localState = yield* LocalState;
            const changed = yield* localState.changes.pipe(
              Stream.filter((value) => value.snippets.some((item) => item.id === awakened.id)),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            const fiber = yield* runSnippetReplicaSync(syncAccount).pipe(Effect.forkChild);
            const value = yield* Fiber.join(changed);
            yield* Fiber.interrupt(fiber);
            return value;
          }),
        ),
      );
      yield* Effect.promise(() => test.runtime.dispose());

      expect(test.currentState()).toEqual({ cursor: "wake", items: [awakened] });
      expect(materialized.snippets).toMatchObject([{ id: awakened.id }]);
    }),
  );
});
