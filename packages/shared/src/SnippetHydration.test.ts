import { describe, expect, it } from "vite-plus/test";
import type { ApiSnippet } from "./api/PlakkApi.ts";
import { DateTime, Effect, Layer, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  SMART_OLDER_MAX_BYTES,
  SMART_RECENT_MAX_BYTES,
  SMART_RECENT_WINDOW_MILLIS,
  SnippetHydrationEngine,
  SnippetHydrationError,
  SnippetHydrationTransport,
  shouldHydrateAutomatically,
} from "./SnippetHydration.ts";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
  SnippetReplica,
  type SnippetReplicaState,
} from "./SnippetReplica.ts";

const now = Date.parse("2026-07-16T12:00:00.000Z");

const candidate = (input?: { readonly age?: number; readonly byteSize?: number }) => ({
  byteSize: input?.byteSize ?? 1,
  createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - (input?.age ?? 0))),
});

describe("Smart snippet retention", () => {
  it("includes recent files through the seven-day and 1 GB boundaries", () => {
    expect(
      shouldHydrateAutomatically(
        candidate({ age: SMART_RECENT_WINDOW_MILLIS, byteSize: SMART_RECENT_MAX_BYTES }),
        now,
        false,
      ),
    ).toBe(true);
    expect(
      shouldHydrateAutomatically(
        candidate({
          age: SMART_RECENT_WINDOW_MILLIS,
          byteSize: SMART_RECENT_MAX_BYTES + 1,
        }),
        now,
        false,
      ),
    ).toBe(false);
  });

  it("uses the 20 MB boundary for older files", () => {
    expect(
      shouldHydrateAutomatically(
        candidate({
          age: SMART_RECENT_WINDOW_MILLIS + 1,
          byteSize: SMART_OLDER_MAX_BYTES,
        }),
        now,
        false,
      ),
    ).toBe(true);
    expect(
      shouldHydrateAutomatically(
        candidate({
          age: SMART_RECENT_WINDOW_MILLIS + 1,
          byteSize: SMART_OLDER_MAX_BYTES + 1,
        }),
        now,
        false,
      ),
    ).toBe(false);
  });

  it("lets keep-all override Smart limits", () => {
    expect(
      shouldHydrateAutomatically(
        candidate({
          age: SMART_RECENT_WINDOW_MILLIS * 10,
          byteSize: SMART_RECENT_MAX_BYTES * 2,
        }),
        now,
        true,
      ),
    ).toBe(true);
  });
});

const account = { id: "account-1", accessToken: "access-token" };
const snippetId = "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0";
const remoteBytes = new TextEncoder().encode("hydrated content");

const apiSnippet = (input?: Partial<ApiSnippet>): ApiSnippet => ({
  id: snippetId,
  fileName: "report.txt",
  byteSize: remoteBytes.byteLength,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-object",
  uploadStatus: "UPLOADED",
  createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  ...input,
});

const hydrationHarness = (input?: {
  readonly snippet?: ApiSnippet;
  readonly snippets?: ReadonlyArray<ApiSnippet>;
  readonly stream?: Stream.Stream<Uint8Array, SnippetHydrationError>;
  readonly putStreamFailure?: ManagedSnippetContentError;
  readonly availableFailureId?: string;
}) => {
  let replicaState: SnippetReplicaState = {
    cursor: "cursor-1",
    items: input?.snippets ?? [input?.snippet ?? apiSnippet()],
  };
  const content = new Map<string, number>();
  const corruptContent = new Set<string>();
  let invalidations = 0;
  let streams = 0;
  let putAttempts = 0;
  let currentStream = input?.stream ?? Stream.succeed(remoteBytes);
  const key = (accountId: string, id: string) => `${accountId}/${id}`;
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      SnippetReplica,
      SnippetReplica.of({
        changes: Stream.empty,
        get: () => Effect.succeed(replicaState),
        commit: (_accountId, state) =>
          Effect.sync(() => {
            replicaState = state;
          }),
        remove: (_accountId, id) =>
          Effect.sync(() => {
            replicaState = {
              ...replicaState,
              items: replicaState.items.filter((snippet) => snippet.id !== id),
            };
          }),
        pendingDeleteIds: () => Effect.succeed([]),
        completeDeleteCleanup: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ManagedSnippetContent,
      ManagedSnippetContent.of({
        get: () => Effect.succeed(null),
        putStream: <E>(
          accountId: string,
          id: string,
          byteSize: number,
          source: Stream.Stream<Uint8Array, E>,
        ) =>
          Effect.suspend((): Effect.Effect<void, E | ManagedSnippetContentError> => {
            putAttempts += 1;
            return input?.putStreamFailure === undefined
              ? Stream.runDrain(source).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      content.set(key(accountId, id), byteSize);
                      corruptContent.delete(key(accountId, id));
                    }),
                  ),
                )
              : Effect.fail(input.putStreamFailure);
          }),
        available: (accountId, id, byteSize) =>
          id === input?.availableFailureId
            ? Effect.fail(
                new ManagedSnippetContentError({
                  cause: null,
                  reason: "Could not inspect managed snippet content.",
                  retryable: true,
                }),
              )
            : Effect.succeed(
                content.get(key(accountId, id)) === byteSize &&
                  !corruptContent.has(key(accountId, id)),
              ),
        invalidate: (accountId, ids) =>
          Effect.sync(() => {
            invalidations += 1;
            for (const id of ids) {
              content.delete(key(accountId, id));
              corruptContent.delete(key(accountId, id));
            }
          }),
      }),
    ),
    Layer.succeed(
      SnippetHydrationTransport,
      SnippetHydrationTransport.of({
        stream: () => {
          streams += 1;
          return currentStream;
        },
      }),
    ),
  );
  const layer = SnippetHydrationEngine.Live.pipe(Layer.provide(dependencies));
  const awaitState = (
    engine: SnippetHydrationEngine["Service"],
    expected: "AVAILABLE" | "DOWNLOADING" | "FAILED" | "NOT_AVAILABLE",
  ) =>
    engine.state(account.id, snippetId, remoteBytes.byteLength).pipe(
      Effect.filterOrFail(
        (state) => state.status === expected,
        () =>
          new SnippetHydrationError({
            cause: null,
            reason: `Hydration did not reach ${expected}`,
            retryable: false,
          }),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 millis"), times: 100 }),
    );

  return {
    content,
    layer,
    removeSnippet: () => {
      replicaState = { ...replicaState, items: [] };
    },
    setStream: (stream: Stream.Stream<Uint8Array, SnippetHydrationError>) => {
      currentStream = stream;
    },
    seedContent: (byteSize: number) => {
      content.set(key(account.id, snippetId), byteSize);
    },
    seedCorruptContent: (byteSize: number) => {
      const contentKey = key(account.id, snippetId);
      content.set(contentKey, byteSize);
      corruptContent.add(contentKey);
    },
    streams: () => streams,
    putAttempts: () => putAttempts,
    invalidations: () => invalidations,
    awaitState,
  };
};

describe("SnippetHydrationEngine", () => {
  it("hydrates Smart-eligible content in the background without a change subscriber", async () => {
    const uploaded = hydrationHarness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* uploaded.awaitState(engine, "AVAILABLE");
      }).pipe(Effect.provide(uploaded.layer)),
    );
    expect(uploaded.streams()).toBe(1);

    const uploading = hydrationHarness({ snippet: apiSnippet({ uploadStatus: "UPLOADING" }) });
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* Effect.sleep("5 millis");
      }).pipe(Effect.provide(uploading.layer)),
    );
    expect(uploading.streams()).toBe(0);
  });

  it("lets a manual download override Smart retention", async () => {
    const oldLarge = hydrationHarness({
      snippet: apiSnippet({
        byteSize: SMART_OLDER_MAX_BYTES + 1,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - SMART_RECENT_WINDOW_MILLIS - 1)),
      }),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        expect(oldLarge.streams()).toBe(0);
        yield* engine.download(account, snippetId);
        yield* engine.state(account.id, snippetId, SMART_OLDER_MAX_BYTES + 1).pipe(
          Effect.filterOrFail(
            (state) => state.status === "AVAILABLE",
            () =>
              new SnippetHydrationError({
                cause: null,
                reason: "Manual hydration did not complete",
                retryable: false,
              }),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 millis"), times: 100 }),
        );
      }).pipe(Effect.provide(oldLarge.layer)),
    );
    expect(oldLarge.streams()).toBe(1);
  });

  it("treats a repeated manual download as idempotent while hydration is active", async () => {
    const active = hydrationHarness({ stream: Stream.never });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* active.awaitState(engine, "DOWNLOADING");
        yield* Effect.sync(active.streams).pipe(
          Effect.filterOrFail(
            (count) => count === 1,
            () =>
              new SnippetHydrationError({
                cause: null,
                reason: "The provider stream did not start.",
                retryable: false,
              }),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 millis"), times: 100 }),
        );
        const invalidations = active.invalidations();
        yield* engine.download(account, snippetId);
        expect(active.invalidations()).toBe(invalidations);
        expect(yield* engine.state(account.id, snippetId, remoteBytes.byteLength)).toEqual({
          status: "DOWNLOADING",
        });
      }).pipe(Effect.provide(active.layer)),
    );

    expect(active.streams()).toBe(1);
  });

  it("atomically reserves hydration across concurrent manual downloads", async () => {
    const byteSize = SMART_OLDER_MAX_BYTES + 1;
    const manual = hydrationHarness({
      snippet: apiSnippet({
        byteSize,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - SMART_RECENT_WINDOW_MILLIS - 1)),
      }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        const invalidations = manual.invalidations();
        yield* Effect.all(
          [engine.download(account, snippetId), engine.download(account, snippetId)],
          { concurrency: "unbounded", discard: true },
        );
        yield* engine.state(account.id, snippetId, byteSize).pipe(
          Effect.filterOrFail(
            (state) => state.status === "AVAILABLE",
            () =>
              new SnippetHydrationError({
                cause: null,
                reason: "Concurrent manual hydration did not finish.",
                retryable: false,
              }),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 millis"), times: 100 }),
        );
        expect(manual.invalidations()).toBe(invalidations + 1);
      }).pipe(Effect.provide(manual.layer)),
    );

    expect(manual.streams()).toBe(1);
  });

  it("lets a manual retry replace locally available content after presentation validation fails", async () => {
    const corrupt = hydrationHarness();
    corrupt.seedCorruptContent(remoteBytes.byteLength);

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* engine.download(account, snippetId);
        yield* corrupt.awaitState(engine, "AVAILABLE");
      }).pipe(Effect.provide(corrupt.layer)),
    );

    expect(corrupt.streams()).toBe(1);
    expect(corrupt.content.get(`${account.id}/${snippetId}`)).toBe(remoteBytes.byteLength);
  });

  it("automatically hydrates every uploaded file when keep-all is enabled", async () => {
    const oldLarge = hydrationHarness({
      snippet: apiSnippet({
        byteSize: SMART_RECENT_MAX_BYTES + 1,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - SMART_RECENT_WINDOW_MILLIS - 1)),
      }),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: true });
        yield* engine.state(account.id, snippetId, SMART_RECENT_MAX_BYTES + 1).pipe(
          Effect.filterOrFail(
            (state) => state.status === "AVAILABLE",
            () =>
              new SnippetHydrationError({
                cause: null,
                reason: "Keep-all hydration did not complete",
                retryable: false,
              }),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 millis"), times: 100 }),
        );
      }).pipe(Effect.provide(oldLarge.layer)),
    );
    expect(oldLarge.streams()).toBe(1);
  });

  it("keeps failures local and allows an explicit retry", async () => {
    const failure = new SnippetHydrationError({
      cause: null,
      reason: "Storage is temporarily unavailable.",
      retryable: false,
    });
    const retryable = hydrationHarness({ stream: Stream.fail(failure) });
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        const failed = yield* retryable.awaitState(engine, "FAILED");
        expect(failed).toEqual({
          status: "FAILED",
          message: "Storage is temporarily unavailable.",
        });
        retryable.setStream(Stream.succeed(remoteBytes));
        yield* engine.download(account, snippetId);
        yield* retryable.awaitState(engine, "AVAILABLE");
      }).pipe(Effect.provide(retryable.layer)),
    );
    expect(retryable.streams()).toBe(2);
  });

  it("retries local hydration after connectivity recovers", async () => {
    const offline = new SnippetHydrationError({
      cause: null,
      reason: "No network connection.",
      retryable: true,
    });
    const recovering = hydrationHarness({ stream: Stream.fail(offline) });

    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* Effect.yieldNow;
        recovering.setStream(Stream.succeed(remoteBytes));
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
        return yield* engine.state(account.id, snippetId, remoteBytes.byteLength);
      }).pipe(Effect.provide(Layer.merge(recovering.layer, TestClock.layer()))),
    );

    expect(state).toEqual({ status: "AVAILABLE" });
    expect(recovering.streams()).toBe(2);
  });

  it("does not periodically retry a permanent provider failure", async () => {
    const forbidden = new SnippetHydrationError({
      cause: null,
      reason: "Storage access was denied.",
      retryable: false,
    });
    const permanent = hydrationHarness({ stream: Stream.fail(forbidden) });

    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* Effect.yieldNow;
        expect(yield* engine.state(account.id, snippetId, remoteBytes.byteLength)).toEqual({
          status: "FAILED",
          message: "Storage access was denied.",
        });
        permanent.setStream(Stream.succeed(remoteBytes));
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
        return yield* engine.state(account.id, snippetId, remoteBytes.byteLength);
      }).pipe(Effect.provide(Layer.merge(permanent.layer, TestClock.layer()))),
    );

    expect(state).toEqual({ status: "FAILED", message: "Storage access was denied." });
    expect(permanent.streams()).toBe(1);
  });

  it("does not retry a deterministic managed-content mismatch", async () => {
    const mismatch = hydrationHarness({
      putStreamFailure: new ManagedSnippetContentError({
        cause: null,
        reason: "Hydrated content does not match its metadata.",
        retryable: false,
      }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* Effect.yieldNow;
        expect(yield* engine.state(account.id, snippetId, remoteBytes.byteLength)).toEqual({
          status: "FAILED",
          message: "Hydrated content does not match its metadata.",
        });
        expect(mismatch.putAttempts()).toBe(1);
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
      }).pipe(Effect.provide(Layer.merge(mismatch.layer, TestClock.layer()))),
    );

    expect(mismatch.putAttempts()).toBe(1);
  });

  it("isolates one local inspection failure from unrelated snippet metadata", async () => {
    const retainedId = "9d72d6f6-9a25-4633-b72f-d8f83cf1c8e1";
    const isolated = hydrationHarness({
      snippets: [
        apiSnippet(),
        apiSnippet({
          id: retainedId,
          byteSize: SMART_OLDER_MAX_BYTES + 1,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - SMART_RECENT_WINDOW_MILLIS - 1)),
        }),
      ],
      availableFailureId: snippetId,
    });

    const availability = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        return yield* engine.reconcile(account.id);
      }).pipe(Effect.provide(isolated.layer)),
    );

    expect(availability.get(snippetId)).toEqual({
      status: "FAILED",
      message: "Could not inspect managed snippet content.",
    });
    expect(availability.get(retainedId)).toEqual({ status: "NOT_AVAILABLE" });
  });

  it("reconciles an incomplete local file and hydrates it again", async () => {
    const corrupted = hydrationHarness();
    corrupted.seedContent(remoteBytes.byteLength - 1);

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* corrupted.awaitState(engine, "AVAILABLE");
      }).pipe(Effect.provide(corrupted.layer)),
    );

    expect(corrupted.streams()).toBe(1);
    expect(corrupted.content.get(`${account.id}/${snippetId}`)).toBe(remoteBytes.byteLength);
  });

  it("recovers unfinished hydration when a fresh engine resumes after restart", async () => {
    const failure = new SnippetHydrationError({
      cause: null,
      reason: "Network connection lost.",
      retryable: false,
    });
    const restarted = hydrationHarness({ stream: Stream.fail(failure) });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* restarted.awaitState(engine, "FAILED");
      }).pipe(Effect.provide(restarted.layer)),
    );

    restarted.setStream(Stream.succeed(remoteBytes));
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* restarted.awaitState(engine, "AVAILABLE");
      }).pipe(Effect.provide(restarted.layer)),
    );

    expect(restarted.streams()).toBe(2);
  });

  it("continues interrupted work after account reauthorization", async () => {
    const reauthorized = hydrationHarness({ stream: Stream.never });

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* reauthorized.awaitState(engine, "DOWNLOADING");
        yield* Effect.sync(reauthorized.streams).pipe(
          Effect.filterOrFail(
            (count) => count === 1,
            () =>
              new SnippetHydrationError({
                cause: null,
                reason: "The first provider stream did not start.",
                retryable: false,
              }),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 millis"), times: 100 }),
        );
        yield* engine.pause;
        reauthorized.setStream(Stream.succeed(remoteBytes));
        yield* engine.resume(
          { ...account, accessToken: "renewed-access-token" },
          { keepAllFilesOffline: false },
        );
        yield* reauthorized.awaitState(engine, "AVAILABLE");
      }).pipe(Effect.provide(reauthorized.layer)),
    );

    expect(reauthorized.streams()).toBe(2);
  });

  it("keeps a deleted snippet from being committed after active hydration", async () => {
    const stalled = hydrationHarness({ stream: Stream.never });
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account, { keepAllFilesOffline: false });
        yield* stalled.awaitState(engine, "DOWNLOADING");
        stalled.removeSnippet();
        yield* engine.reconcile(account.id);
        yield* stalled.awaitState(engine, "NOT_AVAILABLE");
      }).pipe(Effect.provide(stalled.layer)),
    );
    expect(stalled.content.size).toBe(0);
  });
});
