import { describe, expect, it } from "@effect/vitest";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { DateTime, Effect, Layer, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  AUTOMATIC_HYDRATION_LIMIT,
  AUTOMATIC_HYDRATION_MAX_BYTES,
  SnippetHydrationLive,
  automaticHydrationSnippets,
  shouldHydrateAutomatically,
} from "./SnippetHydrationLive.ts";
import { SnippetHydrationEngine, SnippetHydrationError } from "./SnippetHydration.ts";
import { SnippetHydrationTransport } from "./SnippetHydrationTransport.ts";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
} from "../content/ManagedSnippetContent.ts";
import { SnippetReplica, type SnippetReplicaState } from "../replica/SnippetReplica.ts";

const now = Date.parse("2026-07-16T12:00:00.000Z");

describe("automatic snippet hydration", () => {
  it("uses the strict, age-independent below-1-GiB boundary", () => {
    expect(shouldHydrateAutomatically({ byteSize: AUTOMATIC_HYDRATION_MAX_BYTES - 1 })).toBe(true);
    expect(shouldHydrateAutomatically({ byteSize: AUTOMATIC_HYDRATION_MAX_BYTES })).toBe(false);
    expect(shouldHydrateAutomatically({ byteSize: AUTOMATIC_HYDRATION_MAX_BYTES + 1 })).toBe(false);
  });

  it("selects the newest 20 eligible snippets before considering older content", () => {
    const snippets = Array.from({ length: AUTOMATIC_HYDRATION_LIMIT + 3 }, (_, index) =>
      apiSnippet({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        createdAt: new Date(now + index * 1_000).toISOString(),
      }),
    );
    snippets.push(
      apiSnippet({
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        byteSize: AUTOMATIC_HYDRATION_MAX_BYTES,
        createdAt: new Date(now + 100_000).toISOString(),
      }),
    );

    const selected = automaticHydrationSnippets(snippets);

    expect(selected).toHaveLength(AUTOMATIC_HYDRATION_LIMIT);
    expect(selected[0]?.id).toBe("00000000-0000-4000-8000-000000000022");
    expect(selected.at(-1)?.id).toBe("00000000-0000-4000-8000-000000000003");
    expect(selected).not.toContainEqual(
      expect.objectContaining({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
    );
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
  readonly removeExceptFailure?: ManagedSnippetContentError;
  readonly removeExceptFailureAfterCopies?: number;
}) => {
  let replicaState: SnippetReplicaState = {
    items: (input?.snippets ?? [input?.snippet ?? apiSnippet()]).map((snippet) => ({
      kind: "PUBLISHED" as const,
      snippet,
    })),
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
        update: (_accountId, transform) =>
          Effect.sync(() => {
            replicaState = transform(replicaState);
            return replicaState;
          }),
        remove: (_accountId, id) =>
          Effect.sync(() => {
            replicaState = {
              ...replicaState,
              items: replicaState.items.filter((record) =>
                record.kind === "LOCAL" ? record.id !== id : record.snippet.id !== id,
              ),
            };
          }),
        purge: () => Effect.void,
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
        available: (accountId: string, id: string, byteSize: number) =>
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
        invalidate: (accountId: string, ids: ReadonlyArray<string>) =>
          Effect.sync(() => {
            invalidations += 1;
            for (const id of ids) {
              content.delete(key(accountId, id));
              corruptContent.delete(key(accountId, id));
            }
          }),
        removeExcept: (accountId: string, retainedSnippetIds: ReadonlySet<string>) =>
          Effect.gen(function* () {
            if (
              input?.removeExceptFailure !== undefined &&
              input.removeExceptFailureAfterCopies === undefined
            ) {
              return yield* input.removeExceptFailure;
            }
            let reclaimedBytes = 0;
            let removedCopies = 0;
            for (const [contentKey, byteSize] of content) {
              const [owner, id] = contentKey.split("/");
              if (owner === accountId && id !== undefined && !retainedSnippetIds.has(id)) {
                reclaimedBytes += byteSize;
                removedCopies += 1;
                content.delete(contentKey);
                if (
                  input?.removeExceptFailure !== undefined &&
                  removedCopies === input.removeExceptFailureAfterCopies
                ) {
                  return yield* input.removeExceptFailure;
                }
              }
            }
            return { reclaimedBytes, removedCopies };
          }),
        storageUsageBytes: (accountId: string) =>
          Effect.sync(() => {
            let storageUsageBytes = 0;
            for (const [contentKey, byteSize] of content) {
              if (contentKey.startsWith(`${accountId}/`)) storageUsageBytes += byteSize;
            }
            return storageUsageBytes;
          }),
      } as never),
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
  const layer = SnippetHydrationLive.pipe(Layer.provide(dependencies));
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
    setSnippets: (snippets: ReadonlyArray<ApiSnippet>) => {
      replicaState = {
        items: snippets.map((snippet) => ({ kind: "PUBLISHED" as const, snippet })),
      };
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
    records: () => replicaState.items,
    awaitState,
  };
};

describe("SnippetHydrationEngine", () => {
  it.live("hydrates Smart-eligible content in the background without a change subscriber", () =>
    Effect.gen(function* () {
      const uploaded = hydrationHarness();
      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        yield* uploaded.awaitState(engine, "AVAILABLE");
      }).pipe(Effect.provide(uploaded.layer));
      expect(uploaded.streams()).toBe(1);
    }),
  );

  it.live("lets a manual download override the automatic hydration threshold", () =>
    Effect.gen(function* () {
      const oldLarge = hydrationHarness({
        snippet: apiSnippet({
          byteSize: AUTOMATIC_HYDRATION_MAX_BYTES,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        }),
      });
      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        expect(oldLarge.streams()).toBe(0);
        yield* engine.download(account, snippetId);
        yield* engine.state(account.id, snippetId, AUTOMATIC_HYDRATION_MAX_BYTES).pipe(
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
      }).pipe(Effect.provide(oldLarge.layer));
      expect(oldLarge.streams()).toBe(1);
    }),
  );

  it.live("treats a repeated manual download as idempotent while hydration is active", () =>
    Effect.gen(function* () {
      const active = hydrationHarness({ stream: Stream.never });

      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
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
      }).pipe(Effect.provide(active.layer));

      expect(active.streams()).toBe(1);
    }),
  );

  it.live("atomically reserves hydration across concurrent manual downloads", () =>
    Effect.gen(function* () {
      const byteSize = AUTOMATIC_HYDRATION_MAX_BYTES;
      const manual = hydrationHarness({
        snippet: apiSnippet({
          byteSize,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        }),
      });

      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
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
      }).pipe(Effect.provide(manual.layer));

      expect(manual.streams()).toBe(1);
    }),
  );

  it.live(
    "lets a manual retry replace locally available content after presentation validation fails",
    () =>
      Effect.gen(function* () {
        const corrupt = hydrationHarness();
        corrupt.seedCorruptContent(remoteBytes.byteLength);

        yield* Effect.gen(function* () {
          const engine = yield* SnippetHydrationEngine;
          yield* engine.resume(account);
          yield* engine.download(account, snippetId);
          yield* corrupt.awaitState(engine, "AVAILABLE");
        }).pipe(Effect.provide(corrupt.layer));

        expect(corrupt.streams()).toBe(1);
        expect(corrupt.content.get(`${account.id}/${snippetId}`)).toBe(remoteBytes.byteLength);
      }),
  );

  it.live("discards a failed download and allows an ordinary explicit download", () =>
    Effect.gen(function* () {
      const failure = new SnippetHydrationError({
        cause: null,
        reason: "Storage is temporarily unavailable.",
        retryable: false,
      });
      const retryable = hydrationHarness({ stream: Stream.fail(failure) });
      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        yield* retryable.awaitState(engine, "NOT_AVAILABLE");
        retryable.setStream(Stream.succeed(remoteBytes));
        yield* engine.download(account, snippetId);
        yield* retryable.awaitState(engine, "AVAILABLE");
      }).pipe(Effect.provide(retryable.layer));
      expect(retryable.streams()).toBe(2);
    }),
  );

  it.effect("does not schedule a retry after connectivity recovers", () =>
    Effect.gen(function* () {
      const offline = new SnippetHydrationError({
        cause: null,
        reason: "No network connection.",
        retryable: true,
      });
      const recovering = hydrationHarness({ stream: Stream.fail(offline) });

      const state = yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        yield* Effect.yieldNow;
        recovering.setStream(Stream.succeed(remoteBytes));
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
        return yield* engine.state(account.id, snippetId, remoteBytes.byteLength);
      }).pipe(Effect.provide(recovering.layer));

      expect(state).toEqual({ status: "NOT_AVAILABLE" });
      expect(recovering.streams()).toBe(1);
    }),
  );

  it.effect("does not periodically retry a permanent provider failure", () =>
    Effect.gen(function* () {
      const forbidden = new SnippetHydrationError({
        cause: null,
        reason: "Storage access was denied.",
        retryable: false,
      });
      const permanent = hydrationHarness({ stream: Stream.fail(forbidden) });

      const state = yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        yield* Effect.yieldNow;
        expect(yield* engine.state(account.id, snippetId, remoteBytes.byteLength)).toEqual({
          status: "NOT_AVAILABLE",
        });
        permanent.setStream(Stream.succeed(remoteBytes));
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
        return yield* engine.state(account.id, snippetId, remoteBytes.byteLength);
      }).pipe(Effect.provide(permanent.layer));

      expect(state).toEqual({ status: "NOT_AVAILABLE" });
      expect(permanent.streams()).toBe(1);
    }),
  );

  it.effect("does not retry a deterministic managed-content mismatch", () =>
    Effect.gen(function* () {
      const mismatch = hydrationHarness({
        putStreamFailure: new ManagedSnippetContentError({
          cause: null,
          reason: "Hydrated content does not match its metadata.",
          retryable: false,
        }),
      });

      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        yield* Effect.yieldNow;
        expect(yield* engine.state(account.id, snippetId, remoteBytes.byteLength)).toEqual({
          status: "NOT_AVAILABLE",
        });
        expect(mismatch.putAttempts()).toBe(1);
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
      }).pipe(Effect.provide(mismatch.layer));

      expect(mismatch.putAttempts()).toBe(1);
    }),
  );

  it.live("isolates one local inspection failure from unrelated snippet metadata", () =>
    Effect.gen(function* () {
      const retainedId = "9d72d6f6-9a25-4633-b72f-d8f83cf1c8e1";
      const isolated = hydrationHarness({
        snippets: [
          apiSnippet(),
          apiSnippet({
            id: retainedId,
            byteSize: AUTOMATIC_HYDRATION_MAX_BYTES,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          }),
        ],
        availableFailureId: snippetId,
      });

      const availability = yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        return yield* engine.reconcile(account.id);
      }).pipe(Effect.provide(isolated.layer));

      expect(availability.get(snippetId)).toEqual({ status: "NOT_AVAILABLE" });
      expect(availability.get(retainedId)).toEqual({ status: "NOT_AVAILABLE" });
    }),
  );

  it.live("reconciles an incomplete local file and hydrates it again", () =>
    Effect.gen(function* () {
      const corrupted = hydrationHarness();
      corrupted.seedContent(remoteBytes.byteLength - 1);

      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        yield* corrupted.awaitState(engine, "AVAILABLE");
      }).pipe(Effect.provide(corrupted.layer));

      expect(corrupted.streams()).toBe(1);
      expect(corrupted.content.get(`${account.id}/${snippetId}`)).toBe(remoteBytes.byteLength);
    }),
  );

  it.live("uses ordinary automatic selection without persisted recovery state after restart", () =>
    Effect.gen(function* () {
      const failure = new SnippetHydrationError({
        cause: null,
        reason: "Network connection lost.",
        retryable: false,
      });
      const restarted = hydrationHarness({ stream: Stream.fail(failure) });

      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        yield* restarted.awaitState(engine, "NOT_AVAILABLE");
      }).pipe(Effect.provide(restarted.layer));

      restarted.setStream(Stream.succeed(remoteBytes));
      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        yield* restarted.awaitState(engine, "AVAILABLE");
      }).pipe(Effect.provide(restarted.layer));

      expect(restarted.streams()).toBe(2);
    }),
  );

  it.live("returns interrupted work to Download after account reauthorization", () =>
    Effect.gen(function* () {
      const reauthorized = hydrationHarness({ stream: Stream.never });

      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
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
        yield* engine.resume({ ...account, accessToken: "renewed-access-token" });
        yield* reauthorized.awaitState(engine, "NOT_AVAILABLE");
        yield* engine.download({ ...account, accessToken: "renewed-access-token" }, snippetId);
        yield* reauthorized.awaitState(engine, "AVAILABLE");
      }).pipe(Effect.provide(reauthorized.layer));

      expect(reauthorized.streams()).toBe(2);
    }),
  );

  it.live("keeps a deleted snippet from being committed after active hydration", () =>
    Effect.gen(function* () {
      const stalled = hydrationHarness({ stream: Stream.never });
      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        yield* stalled.awaitState(engine, "DOWNLOADING");
        stalled.removeSnippet();
        yield* engine.reconcile(account.id);
        yield* stalled.awaitState(engine, "NOT_AVAILABLE");
      }).pipe(Effect.provide(stalled.layer));
      expect(stalled.content.size).toBe(0);
    }),
  );

  it.live("frees content outside the newest-20 set without removing snippet records", () =>
    Effect.gen(function* () {
      const snippets = Array.from({ length: AUTOMATIC_HYDRATION_LIMIT + 2 }, (_, index) =>
        apiSnippet({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          createdAt: new Date(now + index * 1_000).toISOString(),
        }),
      );
      const storage = hydrationHarness({ snippets });
      for (const snippet of snippets) {
        storage.content.set(`${account.id}/${snippet.id}`, snippet.byteSize);
      }

      const result = yield* SnippetHydrationEngine.use((engine) =>
        engine.freeUpSpace(account.id),
      ).pipe(Effect.provide(storage.layer));

      expect(storage.content.size).toBe(AUTOMATIC_HYDRATION_LIMIT);
      expect(result).toEqual({
        reclaimedBytes: remoteBytes.byteLength * 2,
        removedCopies: 2,
        storageUsageBytes: remoteBytes.byteLength * AUTOMATIC_HYDRATION_LIMIT,
      });
      expect(storage.content.has(`${account.id}/${snippets.at(-1)?.id}`)).toBe(true);
      expect(storage.content.has(`${account.id}/${snippets[0]?.id}`)).toBe(false);
      expect(storage.records()).toEqual(
        snippets.map((snippet) => ({ kind: "PUBLISHED", snippet })),
      );
    }),
  );

  it.live("reports when no older device copies are eligible for removal", () =>
    Effect.gen(function* () {
      const snippets = Array.from({ length: AUTOMATIC_HYDRATION_LIMIT }, (_, index) =>
        apiSnippet({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          createdAt: new Date(now + index * 1_000).toISOString(),
        }),
      );
      const storage = hydrationHarness({ snippets });
      for (const snippet of snippets) {
        storage.content.set(`${account.id}/${snippet.id}`, snippet.byteSize);
      }

      const result = yield* SnippetHydrationEngine.use((engine) =>
        engine.freeUpSpace(account.id),
      ).pipe(Effect.provide(storage.layer));

      expect(result).toEqual({
        reclaimedBytes: 0,
        removedCopies: 0,
        storageUsageBytes: remoteBytes.byteLength * AUTOMATIC_HYDRATION_LIMIT,
      });
      expect(storage.content.size).toBe(AUTOMATIC_HYDRATION_LIMIT);
    }),
  );

  it.live("fails honestly after a partial removal without returning stale usage", () =>
    Effect.gen(function* () {
      const failure = new ManagedSnippetContentError({
        cause: null,
        reason: "Could not free managed snippet content.",
        retryable: true,
      });
      const snippets = Array.from({ length: AUTOMATIC_HYDRATION_LIMIT + 2 }, (_, index) =>
        apiSnippet({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          createdAt: new Date(now + index * 1_000).toISOString(),
        }),
      );
      const storage = hydrationHarness({
        snippets,
        removeExceptFailure: failure,
        removeExceptFailureAfterCopies: 1,
      });
      for (const snippet of snippets) {
        storage.content.set(`${account.id}/${snippet.id}`, snippet.byteSize);
      }

      const result = yield* Effect.flip(
        SnippetHydrationEngine.use((engine) => engine.freeUpSpace(account.id)).pipe(
          Effect.provide(storage.layer),
        ),
      );

      expect(result).toBe(failure);
      expect(storage.content.size).toBe(AUTOMATIC_HYDRATION_LIMIT + 1);
    }),
  );

  it.live("fails without reporting an optimistic storage result", () =>
    Effect.gen(function* () {
      const failure = new ManagedSnippetContentError({
        cause: null,
        reason: "Could not free managed snippet content.",
        retryable: true,
      });
      const storage = hydrationHarness({ removeExceptFailure: failure });
      storage.seedContent(remoteBytes.byteLength);

      const result = yield* Effect.flip(
        SnippetHydrationEngine.use((engine) => engine.freeUpSpace(account.id)).pipe(
          Effect.provide(storage.layer),
        ),
      );

      expect(result).toBe(failure);
      expect(storage.content.size).toBe(1);
    }),
  );

  it.live("does not evict complete content when a snippet leaves the newest-20 window", () =>
    Effect.gen(function* () {
      const retained = apiSnippet();
      const storage = hydrationHarness({ snippet: retained });
      storage.seedContent(retained.byteSize);
      const newer = Array.from({ length: AUTOMATIC_HYDRATION_LIMIT + 1 }, (_, index) =>
        apiSnippet({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          createdAt: new Date(now + (index + 1) * 1_000).toISOString(),
        }),
      );
      storage.setSnippets([...newer, retained]);
      for (const snippet of newer) {
        storage.content.set(`${account.id}/${snippet.id}`, snippet.byteSize);
      }

      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        yield* engine.reconcile(account.id);
      }).pipe(Effect.provide(storage.layer));

      expect(storage.content.has(`${account.id}/${retained.id}`)).toBe(true);
    }),
  );

  it.live("keeps an absent snippet metadata-free after a failed download", () =>
    Effect.gen(function* () {
      const failure = new SnippetHydrationError({
        cause: null,
        reason: "Provider download failed.",
        retryable: false,
      });
      const failed = hydrationHarness({ stream: Stream.fail(failure) });

      yield* Effect.gen(function* () {
        const engine = yield* SnippetHydrationEngine;
        yield* engine.resume(account);
        yield* failed.awaitState(engine, "NOT_AVAILABLE");
        failed.removeSnippet();
        yield* engine.reconcile(account.id);
        expect(yield* engine.state(account.id, snippetId, remoteBytes.byteLength)).toEqual({
          status: "NOT_AVAILABLE",
        });
      }).pipe(Effect.provide(failed.layer));
    }),
  );
});
