import type { User } from "@plakk/shared";
import type { ApiSnippet, SnippetChangePage } from "@plakk/shared/PlakkApi";
import { SnippetHydrationEngine } from "@plakk/shared/SnippetHydration";
import {
  ManagedSnippetContent,
  runSnippetReplicaSync,
  SnippetRemoteTransport,
  SnippetReplica,
  syncSnippetReplica,
  type SnippetReplicaState,
} from "@plakk/shared/SnippetReplica";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Effect, Fiber, Layer, ManagedRuntime, Option, PubSub, Stream } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DesktopProjection,
  DesktopProjectionStore,
  DesktopSnippetProjector,
} from "./DesktopProjection.ts";
import { DesktopManagedSnippetContent } from "./ManagedSnippetContent.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";

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
  uploadStatus: "UPLOADED",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const temporaryDirectories: Array<string> = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const harness = async (options: {
  initial?: SnippetReplicaState | null;
  pages?: Array<SnippetChangePage>;
  snapshot?: SnippetReplicaState;
  wakes?: Stream.Stream<void>;
}) => {
  const cwd = await mkdtemp(join(tmpdir(), "plakk-projection-sync-"));
  temporaryDirectories.push(cwd);
  let state = options.initial ?? null;
  const snapshot = options.snapshot ?? { cursor: "snapshot", items: [] };
  const pages = options.pages ?? [];
  const replicaChanges = await Effect.runPromise(
    PubSub.unbounded<{ readonly accountId: string; readonly items: ReadonlyArray<ApiSnippet> }>(),
  );
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
    updateSettings: () => Effect.void,
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
  const projector = DesktopSnippetProjector.Live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SnippetReplica, replica),
        Layer.succeed(SnippetUploadEngine, uploads),
        Layer.succeed(SnippetHydrationEngine, hydration),
        Layer.succeed(DesktopManagedSnippetContent, desktopContent),
      ),
    ),
  );
  const syncLayer = Layer.mergeAll(
    Layer.succeed(SnippetReplica, replica),
    Layer.succeed(SnippetRemoteTransport, remote),
    Layer.succeed(ManagedSnippetContent, managed),
  );
  const runtime = ManagedRuntime.make(
    Layer.merge(
      DesktopProjection.layer.pipe(
        Layer.provide(Layer.merge(DesktopProjectionStore.layer({ cwd }), projector)),
      ),
      syncLayer,
    ),
  );
  return {
    currentState: () => state,
    runtime,
  };
};

describe("desktop projection synchronization seam", () => {
  it("publishes the initial snapshot through replica changes", async () => {
    const first = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "first.txt");
    const test = await harness({ snapshot: { cursor: "snapshot", items: [first] } });
    await test.runtime.runPromise(
      DesktopProjection.use((projection) => projection.update({ kind: "offline", account: user })),
    );

    const snapshotProjection = await test.runtime.runPromise(
      Effect.gen(function* () {
        const projection = yield* DesktopProjection;
        const changed = yield* projection.changes.pipe(
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
    );
    expect(snapshotProjection.snippets).toMatchObject([{ id: first.id }]);
    await test.runtime.dispose();
  });

  it("publishes pull tombstones through replica changes", async () => {
    const first = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "first.txt");
    const pull = await harness({
      initial: { cursor: "snapshot", items: [first] },
      pages: [
        { status: "OK", changes: [{ type: "DELETE", snippetId: first.id }], nextCursor: "pulled" },
      ],
    });
    await pull.runtime.runPromise(
      DesktopProjection.use((projection) => projection.update({ kind: "offline", account: user })),
    );
    const pullProjection = await pull.runtime.runPromise(
      Effect.gen(function* () {
        const projection = yield* DesktopProjection;
        const changed = yield* projection.changes.pipe(
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
    );
    expect(pull.currentState()).toEqual({ cursor: "pulled", items: [] });
    expect(pullProjection).toMatchObject({ snippets: [] });
    await pull.runtime.dispose();
  });

  it("publishes required resnapshots through replica changes", async () => {
    const second = snippet("1d1e2f3a-4567-4890-8abc-def012345679", "second.txt");
    const resnapshot = await harness({
      initial: { cursor: "pulled", items: [] },
      pages: [{ status: "RESNAPSHOT_REQUIRED" }],
      snapshot: { cursor: "fresh", items: [second] },
    });
    await resnapshot.runtime.runPromise(
      DesktopProjection.use((projection) => projection.update({ kind: "offline", account: user })),
    );
    const projected = await resnapshot.runtime.runPromise(
      Effect.gen(function* () {
        const projection = yield* DesktopProjection;
        const changed = yield* projection.changes.pipe(
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
    );
    await resnapshot.runtime.dispose();

    expect(resnapshot.currentState()).toEqual({ cursor: "fresh", items: [second] });
    expect(projected.snippets).toMatchObject([{ id: second.id }]);
    expect(projected.snippets[0]).not.toHaveProperty("storageObjectId");
  });

  it("projects a pull triggered by the desktop wake stream", async () => {
    const awakened = snippet("2d1e2f3a-4567-4890-8abc-def012345670", "awakened.txt");
    const test = await harness({
      initial: { cursor: "old", items: [] },
      pages: [
        { status: "OK", changes: [], nextCursor: "old" },
        { status: "OK", changes: [{ type: "UPSERT", snippet: awakened }], nextCursor: "wake" },
      ],
      wakes: Stream.make(undefined),
    });
    await test.runtime.runPromise(
      DesktopProjection.use((projection) => projection.update({ kind: "offline", account: user })),
    );
    const projected = await test.runtime.runPromise(
      Effect.gen(function* () {
        const projection = yield* DesktopProjection;
        const changed = yield* projection.changes.pipe(
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
    );
    await test.runtime.dispose();

    expect(test.currentState()).toEqual({ cursor: "wake", items: [awakened] });
    expect(projected.snippets).toMatchObject([{ id: awakened.id }]);
  });
});
