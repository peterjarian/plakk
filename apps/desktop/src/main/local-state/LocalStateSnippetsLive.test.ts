import { NodeFileSystem } from "@effect/platform-node";
import type { User } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, ManagedRuntime, Option, PubSub, Stream } from "effect";

import { ManagedSnippetContent } from "../snippets/content/ManagedSnippetContent.ts";
import { SnippetHydrationEngine } from "../snippets/hydration/SnippetHydration.ts";
import { SnippetRemoteTransport } from "../snippets/replica/SnippetRemoteTransport.ts";
import { SnippetReplica, type SnippetReplicaState } from "../snippets/replica/SnippetReplica.ts";
import { runSnippetReplicaSync, syncSnippetReplica } from "../snippets/replica/sync.ts";
import { LocalState } from "./LocalState.ts";
import { LocalStateLive } from "./LocalStateLive.ts";
import { LocalStateSnippetsLive } from "./LocalStateSnippetsLive.ts";
import { makeLocalStateStoreLive } from "./LocalStateStoreLive.ts";

const user: User = {
  id: "user_1",
  email: "user_1@example.com",
  firstName: "Desktop",
  lastName: "Reader",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const syncAccount = { id: user.id, accessToken: "token" };
const snippet = (id: string, fileName: string): ApiSnippet => ({
  id,
  fileName,
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: `provider-${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const harness = (options: {
  initial?: SnippetReplicaState | null;
  snapshots: Array<ReadonlyArray<ApiSnippet>>;
  invalidations?: Stream.Stream<void>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-sync-" });
    let state = options.initial ?? null;
    const replicaChanges = yield* PubSub.unbounded<{
      readonly accountId: string;
      readonly items: SnippetReplicaState["items"];
    }>();
    const replica = SnippetReplica.of({
      changes: Stream.fromPubSub(replicaChanges),
      get: () => Effect.succeed(state),
      commit: (accountId, next) =>
        Effect.sync(() => void (state = next)).pipe(
          Effect.andThen(PubSub.publish(replicaChanges, { accountId, items: next.items })),
          Effect.asVoid,
        ),
      update: (accountId, transform) =>
        Effect.sync(() => {
          state = transform(state ?? { items: [] });
          return state;
        }).pipe(
          Effect.tap((next) => PubSub.publish(replicaChanges, { accountId, items: next.items })),
        ),
      purge: (accountId) =>
        Effect.sync(() => void (state = null)).pipe(
          Effect.andThen(PubSub.publish(replicaChanges, { accountId, items: [] })),
          Effect.asVoid,
        ),
      remove: (accountId, id) =>
        Effect.sync(() => {
          if (state !== null) {
            state = {
              items: state.items.filter((item) =>
                item.kind === "LOCAL" ? item.id !== id : item.snippet.id !== id,
              ),
            };
          }
        }).pipe(
          Effect.andThen(PubSub.publish(replicaChanges, { accountId, items: state?.items ?? [] })),
          Effect.asVoid,
        ),
    });
    const remote = SnippetRemoteTransport.of({
      snapshot: () =>
        Effect.sync(() => {
          const next = options.snapshots.shift();
          if (next === undefined) throw new Error("Missing scripted snapshot");
          return next;
        }),
      invalidations: () => options.invalidations ?? Stream.never,
    });
    const managed = ManagedSnippetContent.of({
      available: () => Effect.succeed(false),
      get: () => Effect.succeed(null),
      invalidate: () => Effect.void,
      putStream: () => Effect.void,
    } as never);
    const hydration = SnippetHydrationEngine.of({
      changes: Stream.empty,
      download: () => Effect.void,
      freeUpSpace: () => Effect.void,
      pause: Effect.void,
      purge: () => Effect.void,
      reconcile: () =>
        Effect.succeed(
          new Map(
            (state?.items ?? []).flatMap((item) =>
              item.kind === "PUBLISHED"
                ? [[item.snippet.id, { status: "NOT_AVAILABLE" } as const] as const]
                : [],
            ),
          ),
        ),
      resume: () => Effect.void,
      state: () => Effect.succeed({ status: "NOT_AVAILABLE" }),
    });
    const desktopContent = ManagedSnippetContent.of({
      available: () => Effect.succeed(false),
      changes: Stream.empty,
      discard: () => Effect.void,
      get: () => Effect.succeed(null),
      getPrefix: () => Effect.succeed(null),
      ingest: () => Effect.succeed("/managed/content"),
      invalidate: () => Effect.void,
      path: () => Effect.succeed("/managed/content"),
      purge: () => Effect.void,
      putStream: () => Effect.void,
      removeExcept: () => Effect.void,
      storageUsageBytes: () => Effect.succeed(0),
      validateText: () => Effect.succeed("NOT_FOUND"),
    });
    const replicaLayer = Layer.succeed(SnippetReplica, replica);
    const localStateSnippets = LocalStateSnippetsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          replicaLayer,
          Layer.succeed(SnippetHydrationEngine, hydration),
          Layer.succeed(ManagedSnippetContent, desktopContent),
        ),
      ),
    );
    const runtime = ManagedRuntime.make(
      Layer.merge(
        LocalStateLive.pipe(
          Layer.provide(Layer.merge(makeLocalStateStoreLive({ cwd }), localStateSnippets)),
        ),
        Layer.mergeAll(
          replicaLayer,
          Layer.succeed(SnippetRemoteTransport, remote),
          Layer.succeed(ManagedSnippetContent, managed),
        ),
      ),
    );
    return { currentState: () => state, runtime };
  });

it.layer(NodeFileSystem.layer)("local state snapshot seam", (it) => {
  it.effect("publishes a complete snapshot through the shared Local State projection", () =>
    Effect.gen(function* () {
      const published = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "published.txt");
      const test = yield* harness({ snapshots: [[published]] });
      yield* Effect.promise(() =>
        test.runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "offline", account: user })),
        ),
      );
      const materialized = yield* Effect.promise(() =>
        test.runtime.runPromise(
          Effect.gen(function* () {
            const localState = yield* LocalState;
            yield* syncSnippetReplica(syncAccount);
            yield* localState.refresh;
            return yield* localState.current;
          }),
        ),
      );

      expect(test.currentState()).toEqual({
        items: [{ kind: "PUBLISHED", snippet: published }],
      });
      expect(materialized.snippets).toMatchObject([{ id: published.id }]);
      expect(materialized.snippets[0]).not.toHaveProperty("storageObjectId");
      yield* Effect.promise(() => test.runtime.dispose());
    }),
  );

  it.effect("publishes deletion by absence and cleans compatible upload state", () =>
    Effect.gen(function* () {
      const published = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "published.txt");
      const test = yield* harness({
        initial: { items: [{ kind: "PUBLISHED", snippet: published }] },
        snapshots: [[]],
      });
      yield* Effect.promise(() =>
        test.runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "offline", account: user })),
        ),
      );
      yield* Effect.promise(() => test.runtime.runPromise(syncSnippetReplica(syncAccount)));

      expect(test.currentState()).toEqual({ items: [] });
      const localState = yield* Effect.promise(() =>
        test.runtime.runPromise(
          LocalState.use((service) => service.refresh.pipe(Effect.andThen(service.current))),
        ),
      );
      expect(localState.snippets).toEqual([]);
      yield* Effect.promise(() => test.runtime.dispose());
    }),
  );

  it.effect("refreshes Local State for each live invalidation", () =>
    Effect.gen(function* () {
      const published = snippet("2d1e2f3a-4567-4901-8abc-def012345670", "awakened.txt");
      const test = yield* harness({
        snapshots: [[], [published]],
        invalidations: Stream.make(undefined, undefined).pipe(Stream.concat(Stream.never)),
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
              Stream.filter((value) => value.snippets.some((item) => item.id === published.id)),
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

      expect(materialized.snippets).toMatchObject([{ id: published.id }]);
      yield* Effect.promise(() => test.runtime.dispose());
    }),
  );
});
