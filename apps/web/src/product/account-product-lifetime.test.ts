import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it } from "@effect/vitest";
import { Data, DateTime, Deferred, Effect, Fiber, Layer, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { AccountProductLifetime, clearProductThenSignOut } from "./account-product-lifetime.ts";
import { AccountProductReader, type AccountProductSnapshot } from "./product-reader.ts";
import {
  AccountProductMirror,
  AccountProductMirrorError,
  makeSessionMemoryAccountProductMirrorLayer,
} from "./readable-mirror.ts";

const account: AccountStatus = {
  accessEntitlement: {
    status: "TRIAL_ACTIVE",
    trialEndsAt: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
  },
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
  blockedReasons: [],
};

const expiringAccount: AccountStatus = {
  ...account,
  accessEntitlement: {
    status: "TRIAL_ACTIVE",
    trialEndsAt: DateTime.makeUnsafe(1_000),
  },
};

const snippet = (id: string): ApiSnippet => ({
  id,
  fileName: `${id}.png`,
  byteSize: 128,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: `object-${id}`,
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
});

const INITIAL_AND_CONNECTED_REFRESH_COUNT = 2;

const provideLifetime = (
  read: AccountProductReader["Service"]["read"],
  invalidations: AccountProductReader["Service"]["invalidations"] = Stream.make(undefined).pipe(
    Stream.concat(Stream.never),
  ),
  mirrorLayer = makeSessionMemoryAccountProductMirrorLayer(),
) =>
  AccountProductLifetime.layer.pipe(
    Layer.provideMerge(
      Layer.merge(
        Layer.succeed(AccountProductReader, AccountProductReader.of({ invalidations, read })),
        mirrorLayer,
      ),
    ),
  );

class PurgeFailure extends Data.TaggedError("PurgeFailure") {}

describe("account product lifetime", () => {
  it.effect(
    "transitions the visible account at the exact trial expiry without an invalidation",
    () =>
      Effect.gen(function* () {
        const lifetime = yield* AccountProductLifetime;
        yield* lifetime.enter("user_1");
        yield* Effect.yieldNow;

        expect(lifetime.getSnapshot()).toMatchObject({
          account: {
            accessEntitlement: { status: "TRIAL_ACTIVE" },
            blockedReasons: [],
            canSync: true,
          },
          kind: "ready",
        });

        yield* TestClock.adjust("999 millis");
        yield* Effect.yieldNow;
        expect(lifetime.getSnapshot()).toMatchObject({
          account: { accessEntitlement: { status: "TRIAL_ACTIVE" } },
        });

        yield* TestClock.adjust("1 millis");
        yield* Effect.yieldNow;
        expect(lifetime.getSnapshot()).toMatchObject({
          account: {
            accessEntitlement: { status: "BILLING_RESTRICTED" },
            blockedReasons: ["billing"],
            canSync: false,
          },
          kind: "ready",
        });
      }).pipe(
        Effect.provide(
          Layer.merge(
            provideLifetime(Effect.succeed({ account: expiringAccount, snippets: [] })),
            TestClock.layer(),
          ),
        ),
      ),
  );

  it.effect("presents the last-confirmed mirror while the backend refresh remains pending", () =>
    Effect.gen(function* () {
      const pending = yield* Deferred.make<AccountProductSnapshot>();
      const lifetimeLayer = AccountProductLifetime.layer.pipe(
        Layer.provideMerge(
          Layer.merge(
            Layer.succeed(
              AccountProductReader,
              AccountProductReader.of({
                invalidations: Stream.never,
                read: Deferred.await(pending),
              }),
            ),
            makeSessionMemoryAccountProductMirrorLayer({
              initial: { account, snippets: [snippet("mirrored")] },
              readPerformance: "accelerated",
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const lifetime = yield* AccountProductLifetime;
        yield* lifetime.enter("user_1");
        expect(lifetime.getSnapshot()).toEqual({
          account,
          accountId: "user_1",
          apiAvailability: "checking",
          kind: "ready",
          liveConnection: "reconnecting",
          localReadPerformance: "accelerated",
          snippets: [snippet("mirrored")],
        });
      }).pipe(Effect.provide(lifetimeLayer));
    }),
  );

  it.effect("stores a successful authoritative refresh in the readable mirror", () =>
    Effect.gen(function* () {
      const lifetime = yield* AccountProductLifetime;
      const mirror = yield* AccountProductMirror;
      yield* lifetime.enter("user_1");

      expect(yield* mirror.read).toEqual({
        account,
        snippets: [snippet("remote")],
      });
    }).pipe(
      Effect.provide(provideLifetime(Effect.succeed({ account, snippets: [snippet("remote")] }))),
    ),
  );

  it.effect("removes purged facts and accepts a later peer replacement", () =>
    Effect.gen(function* () {
      const mirrorChanges = yield* Queue.unbounded<"purge" | "replace">();
      let mirrored: AccountProductSnapshot | null = {
        account,
        snippets: [snippet("mirrored")],
      };
      const mirrorLayer = Layer.succeed(
        AccountProductMirror,
        AccountProductMirror.of({
          changes: Stream.fromQueue(mirrorChanges),
          purge: Effect.sync(() => {
            mirrored = null;
          }),
          read: Effect.sync(() => mirrored),
          readPerformance: () => "accelerated",
          replace: (snapshot) =>
            Effect.sync(() => {
              mirrored = snapshot;
            }),
          synchronize: (operation) => operation,
        }),
      );

      yield* Effect.gen(function* () {
        const lifetime = yield* AccountProductLifetime;
        yield* lifetime.enter("user_1");
        expect(lifetime.getSnapshot()).toMatchObject({
          kind: "ready",
          snippets: [snippet("mirrored")],
        });

        mirrored = null;
        yield* Queue.offer(mirrorChanges, "purge");
        yield* Effect.yieldNow;

        expect(lifetime.getSnapshot()).toEqual({ accountId: "user_1", kind: "loading" });

        mirrored = { account, snippets: [snippet("restored")] };
        yield* Queue.offer(mirrorChanges, "replace");
        yield* Effect.yieldNow;

        expect(lifetime.getSnapshot()).toMatchObject({
          kind: "ready",
          snippets: [snippet("restored")],
        });
      }).pipe(Effect.provide(provideLifetime(Effect.never, Stream.never, mirrorLayer)));
    }),
  );

  it.effect("rebuilds after a corrupt-row purge without waiting for another invalidation", () =>
    Effect.gen(function* () {
      const mirrorChanged = yield* Deferred.make<void>();
      const rebuilt = yield* Deferred.make<AccountProductSnapshot>();
      let mirrored: AccountProductSnapshot | null = {
        account,
        snippets: [snippet("mirrored")],
      };
      const mirrorLayer = Layer.succeed(
        AccountProductMirror,
        AccountProductMirror.of({
          changes: Stream.fromEffect(
            Deferred.await(mirrorChanged).pipe(Effect.as("rebuild" as const)),
          ).pipe(Stream.concat(Stream.never)),
          purge: Effect.void,
          read: Effect.sync(() => mirrored),
          readPerformance: () => "accelerated",
          replace: (snapshot) =>
            Effect.sync(() => {
              mirrored = snapshot;
            }),
          synchronize: (operation) => operation,
        }),
      );

      yield* Effect.gen(function* () {
        const lifetime = yield* AccountProductLifetime;
        yield* lifetime.enter("user_1");
        expect(lifetime.getSnapshot()).toMatchObject({ snippets: [snippet("mirrored")] });

        mirrored = null;
        yield* Deferred.succeed(mirrorChanged, undefined);
        yield* Effect.yieldNow;
        expect(lifetime.getSnapshot()).toEqual({ accountId: "user_1", kind: "loading" });

        yield* Deferred.succeed(rebuilt, { account, snippets: [snippet("rebuilt")] });
        yield* Effect.yieldNow;
        expect(lifetime.getSnapshot()).toMatchObject({
          apiAvailability: "available",
          snippets: [snippet("rebuilt")],
        });
      }).pipe(Effect.provide(provideLifetime(Deferred.await(rebuilt), Stream.never, mirrorLayer)));
    }),
  );

  it.effect("subscribes before hydration so a racing mirror replacement cannot be lost", () =>
    Effect.gen(function* () {
      const initialRead = yield* Deferred.make<AccountProductSnapshot | null>();
      const mirrorChanged = yield* Deferred.make<void>();
      let reads = 0;
      const replacement = { account, snippets: [snippet("replacement")] };
      const mirrorLayer = Layer.succeed(
        AccountProductMirror,
        AccountProductMirror.of({
          changes: Stream.fromEffect(
            Deferred.await(mirrorChanged).pipe(Effect.as("replace" as const)),
          ).pipe(Stream.concat(Stream.never)),
          purge: Effect.void,
          read: Effect.suspend(() => {
            reads += 1;
            return reads === 1 ? Deferred.await(initialRead) : Effect.succeed(replacement);
          }),
          readPerformance: () => "accelerated",
          replace: () => Effect.void,
          synchronize: (operation) => operation,
        }),
      );

      yield* Effect.gen(function* () {
        const lifetime = yield* AccountProductLifetime;
        const enterFiber = yield* Effect.forkChild(lifetime.enter("user_1"), {
          startImmediately: true,
        });
        yield* Effect.yieldNow;
        yield* Deferred.succeed(mirrorChanged, undefined);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(initialRead, { account, snippets: [snippet("stale")] });
        yield* Fiber.join(enterFiber);
        yield* Effect.yieldNow;

        expect(lifetime.getSnapshot()).toMatchObject({
          snippets: [snippet("replacement")],
        });
      }).pipe(Effect.provide(provideLifetime(Effect.never, Stream.never, mirrorLayer)));
    }),
  );

  it.effect("publishes degraded performance when a mirror notification read fails", () =>
    Effect.gen(function* () {
      const mirrorChanged = yield* Deferred.make<void>();
      const mirrorFailure = new AccountProductMirrorError({
        cause: new Error("worker stopped"),
        reason: "Could not read the readable mirror.",
      });
      let firstRead = true;
      let readPerformance: "accelerated" | "degraded" = "accelerated";
      const mirrorLayer = Layer.succeed(
        AccountProductMirror,
        AccountProductMirror.of({
          changes: Stream.fromEffect(
            Deferred.await(mirrorChanged).pipe(Effect.as("replace" as const)),
          ).pipe(Stream.concat(Stream.never)),
          purge: Effect.void,
          read: Effect.suspend(() => {
            if (!firstRead) {
              readPerformance = "degraded";
              return Effect.fail(mirrorFailure);
            }
            firstRead = false;
            return Effect.succeed({ account, snippets: [snippet("mirrored")] });
          }),
          readPerformance: () => readPerformance,
          replace: () => Effect.void,
          synchronize: (operation) => operation,
        }),
      );

      yield* Effect.gen(function* () {
        const lifetime = yield* AccountProductLifetime;
        yield* lifetime.enter("user_1");
        expect(lifetime.getSnapshot()).toMatchObject({
          kind: "ready",
          localReadPerformance: "accelerated",
        });

        yield* Deferred.succeed(mirrorChanged, undefined);
        yield* Effect.yieldNow;

        expect(lifetime.getSnapshot()).toMatchObject({
          kind: "ready",
          localReadPerformance: "degraded",
        });
      }).pipe(Effect.provide(provideLifetime(Effect.never, Stream.never, mirrorLayer)));
    }),
  );

  it.effect("loads one authoritative account snapshot for the active identity", () => {
    const expectedSnippet = snippet(crypto.randomUUID());
    return Effect.gen(function* () {
      const lifetime = yield* AccountProductLifetime;
      yield* lifetime.enter("user_1");
      expect(lifetime.getSnapshot()).toEqual({
        account,
        accountId: "user_1",
        apiAvailability: "available",
        kind: "ready",
        liveConnection: "connected",
        localReadPerformance: "degraded",
        snippets: [expectedSnippet],
      });
    }).pipe(
      Effect.provide(provideLifetime(Effect.succeed({ account, snippets: [expectedSnippet] }))),
    );
  });

  it.effect("fences a late result from the previous account", () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<AccountProductSnapshot>();
      const second = yield* Deferred.make<AccountProductSnapshot>();
      const calls = yield* Ref.make(0);
      const firstSnippet = snippet("first");
      const secondSnippet = snippet("second");
      const read = Effect.suspend(() =>
        Ref.getAndUpdate(calls, (count) => count + 1).pipe(
          Effect.flatMap((count) => Deferred.await(count === 0 ? first : second)),
        ),
      );
      const lifetimeLayer = provideLifetime(read);

      yield* Effect.gen(function* () {
        const lifetime = yield* AccountProductLifetime;
        yield* lifetime.enter("user_1");
        yield* lifetime.enter("user_2");
        yield* Deferred.succeed(second, { account, snippets: [secondSnippet] });
        yield* Effect.yieldNow;
        yield* Deferred.succeed(first, { account, snippets: [firstSnippet] });
        yield* Effect.yieldNow;

        expect(lifetime.getSnapshot()).toEqual({
          account,
          accountId: "user_2",
          apiAvailability: "available",
          kind: "ready",
          liveConnection: "connected",
          localReadPerformance: "degraded",
          snippets: [secondSnippet],
        });
      }).pipe(Effect.provide(lifetimeLayer));
    }),
  );

  it.effect("revokes active work and clears every prior account fact before sign-out", () =>
    Effect.gen(function* () {
      const interrupted = yield* Ref.make(false);
      const read = Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true)));

      yield* Effect.gen(function* () {
        const lifetime = yield* AccountProductLifetime;
        yield* lifetime.enter("user_1");
        yield* lifetime.clear;

        expect(yield* Ref.get(interrupted)).toBe(true);
        expect(lifetime.getSnapshot()).toEqual({ kind: "idle" });
      }).pipe(Effect.provide(provideLifetime(read)));
    }),
  );

  it.effect("restores an actionable degraded account state when durable purge fails", () =>
    Effect.gen(function* () {
      const purgeFailure = new AccountProductMirrorError({
        cause: new Error("OPFS unavailable"),
        reason: "Could not purge the readable mirror.",
      });
      const mirrorLayer = Layer.succeed(
        AccountProductMirror,
        AccountProductMirror.of({
          changes: Stream.never,
          purge: Effect.fail(purgeFailure),
          read: Effect.succeed({ account, snippets: [snippet("mirrored")] }),
          readPerformance: () => "degraded",
          replace: () => Effect.void,
          synchronize: (operation) => operation,
        }),
      );

      yield* Effect.gen(function* () {
        const lifetime = yield* AccountProductLifetime;
        yield* lifetime.enter("user_1");
        expect(yield* lifetime.clear.pipe(Effect.flip)).toBe(purgeFailure);
        yield* Effect.yieldNow;

        expect(lifetime.getSnapshot()).toMatchObject({
          accountId: "user_1",
          kind: "ready",
          localReadPerformance: "degraded",
        });
      }).pipe(
        Effect.provide(
          provideLifetime(
            Effect.succeed({ account, snippets: [snippet("remote")] }),
            Stream.never,
            mirrorLayer,
          ),
        ),
      );
    }),
  );

  it.effect("retains an honest retryable failure cause for the current account", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const failure = new RpcError({
        code: "INTERNAL_SERVER_ERROR",
        message: "backend unavailable",
      });
      const read = Ref.getAndUpdate(calls, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === 0 ? Effect.fail(failure) : Effect.succeed({ account, snippets: [] }),
        ),
      );

      yield* Effect.gen(function* () {
        const lifetime = yield* AccountProductLifetime;
        yield* lifetime.enter("user_1");
        yield* Effect.yieldNow;
        expect(lifetime.getSnapshot()).toEqual({
          accountId: "user_1",
          cause: failure,
          kind: "failed",
        });

        yield* lifetime.retry;
        yield* Effect.yieldNow;
        expect(lifetime.getSnapshot()).toEqual({
          account,
          accountId: "user_1",
          apiAvailability: "available",
          kind: "ready",
          liveConnection: "reconnecting",
          localReadPerformance: "degraded",
          snippets: [],
        });
      }).pipe(Effect.provide(provideLifetime(read, Stream.never)));
    }),
  );

  it.effect(
    "loads independently and reports reconnecting when only the invalidation stream is unavailable",
    () =>
      Effect.gen(function* () {
        const failure = new RpcError({
          code: "INTERNAL_SERVER_ERROR",
          message: "stream unavailable",
        });

        yield* Effect.gen(function* () {
          const lifetime = yield* AccountProductLifetime;
          yield* lifetime.enter("user_1");
          yield* Effect.yieldNow;
          expect(lifetime.getSnapshot()).toEqual({
            account,
            accountId: "user_1",
            apiAvailability: "available",
            kind: "ready",
            liveConnection: "reconnecting",
            localReadPerformance: "degraded",
            snippets: [],
          });
        }).pipe(
          Effect.provide(
            provideLifetime(Effect.succeed({ account, snippets: [] }), Stream.fail(failure)),
          ),
        );
      }),
  );

  it.effect("cleans product data before credential sign-out and fails closed", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      yield* clearProductThenSignOut(
        Effect.sync(() => void order.push("clear")),
        Effect.sync(() => void order.push("sign-out")),
        Effect.sync(() => void order.push("restore")),
      );
      expect(order).toEqual(["clear", "sign-out"]);

      const signOutCalled = yield* Ref.make(false);
      const restoreCalled = yield* Ref.make(false);
      const failure = yield* clearProductThenSignOut(
        Effect.fail(new PurgeFailure()),
        Ref.set(signOutCalled, true),
        Ref.set(restoreCalled, true),
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PurgeFailure);
      expect(yield* Ref.get(signOutCalled)).toBe(false);
      expect(yield* Ref.get(restoreCalled)).toBe(false);
    }),
  );

  it.effect("restores the current account after delegated sign-out fails", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const failure = new PurgeFailure();

      const actualFailure = yield* clearProductThenSignOut(
        Effect.sync(() => void order.push("clear")),
        Effect.gen(function* () {
          order.push("sign-out");
          return yield* failure;
        }),
        Effect.sync(() => void order.push("restore")),
      ).pipe(Effect.flip);

      expect(actualFailure).toBe(failure);
      expect(order).toEqual(["clear", "sign-out", "restore"]);
    }),
  );
});

it.effect("replaces the complete collection atomically on an invalidation", () =>
  Effect.gen(function* () {
    const nextInvalidation = yield* Deferred.make<void>();
    const reads = yield* Ref.make(0);
    const firstSnippet = snippet("first");
    const secondSnippet = snippet("second");
    const read = Ref.getAndUpdate(reads, (count) => count + 1).pipe(
      Effect.map((count) => ({
        account,
        snippets: count < INITIAL_AND_CONNECTED_REFRESH_COUNT ? [firstSnippet] : [secondSnippet],
      })),
    );
    const invalidations = Stream.make(undefined).pipe(
      Stream.concat(Stream.fromEffect(Deferred.await(nextInvalidation))),
      Stream.concat(Stream.never),
    );

    yield* Effect.gen(function* () {
      const lifetime = yield* AccountProductLifetime;
      yield* lifetime.enter("user_1");
      yield* Effect.yieldNow;
      expect(lifetime.getSnapshot()).toMatchObject({
        apiAvailability: "available",
        liveConnection: "connected",
        snippets: [firstSnippet],
      });

      yield* Deferred.succeed(nextInvalidation, undefined);
      yield* Effect.yieldNow;
      expect(lifetime.getSnapshot()).toEqual({
        account,
        accountId: "user_1",
        apiAvailability: "available",
        kind: "ready",
        liveConnection: "connected",
        localReadPerformance: "degraded",
        snippets: [secondSnippet],
      });
    }).pipe(Effect.provide(provideLifetime(read, invalidations)));
  }),
);

it.effect("refreshes the complete snapshot after stream reconnection", () =>
  Effect.gen(function* () {
    const connectionAttempts = yield* Ref.make(0);
    const snapshotReads = yield* Ref.make(0);
    const firstSnippet = snippet("first");
    const secondSnippet = snippet("second");
    const invalidations = Stream.unwrap(
      Ref.getAndUpdate(connectionAttempts, (count) => count + 1).pipe(
        Effect.map((count) =>
          count === 0
            ? Stream.make(undefined).pipe(
                Stream.concat(
                  Stream.fail(
                    new RpcError({
                      code: "INTERNAL_SERVER_ERROR",
                      message: "stream disconnected",
                    }),
                  ),
                ),
              )
            : Stream.make(undefined).pipe(Stream.concat(Stream.never)),
        ),
      ),
    );
    const read = Ref.getAndUpdate(snapshotReads, (count) => count + 1).pipe(
      Effect.map((count) => ({
        account,
        snippets: count < INITIAL_AND_CONNECTED_REFRESH_COUNT ? [firstSnippet] : [secondSnippet],
      })),
    );

    yield* Effect.gen(function* () {
      const lifetime = yield* AccountProductLifetime;
      yield* lifetime.enter("user_1");
      yield* Effect.yieldNow;
      expect(lifetime.getSnapshot()).toMatchObject({
        apiAvailability: "available",
        liveConnection: "reconnecting",
        snippets: [firstSnippet],
      });

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(connectionAttempts)).toBe(2);
      expect(yield* Ref.get(snapshotReads)).toBe(3);
      expect(lifetime.getSnapshot()).toEqual({
        account,
        accountId: "user_1",
        apiAvailability: "available",
        kind: "ready",
        liveConnection: "connected",
        localReadPerformance: "degraded",
        snippets: [secondSnippet],
      });
    }).pipe(Effect.provide(Layer.merge(provideLifetime(read, invalidations), TestClock.layer())));
  }),
);

it.effect("backs off consecutive stream connection failures", () =>
  Effect.gen(function* () {
    const connectionAttempts = yield* Ref.make(0);
    const failure = new RpcError({
      code: "INTERNAL_SERVER_ERROR",
      message: "stream unavailable",
    });
    const invalidations = Stream.unwrap(
      Ref.updateAndGet(connectionAttempts, (count) => count + 1).pipe(
        Effect.as(Stream.fail(failure)),
      ),
    );

    yield* Effect.gen(function* () {
      const lifetime = yield* AccountProductLifetime;
      yield* lifetime.enter("user_1");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(connectionAttempts)).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(connectionAttempts)).toBe(2);

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(connectionAttempts)).toBe(2);

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(connectionAttempts)).toBe(3);
    }).pipe(
      Effect.provide(
        Layer.merge(
          provideLifetime(Effect.succeed({ account, snippets: [] }), invalidations),
          TestClock.layer(),
        ),
      ),
    );
  }),
);

it.effect("observes a stream disconnect while a snapshot refresh is hung", () =>
  Effect.gen(function* () {
    const allowInvalidation = yield* Deferred.make<void>();
    const connectionAttempts = yield* Ref.make(0);
    const snapshotReads = yield* Ref.make(0);
    const firstSnippet = snippet("first");
    const secondSnippet = snippet("second");
    const disconnect = new RpcError({
      code: "INTERNAL_SERVER_ERROR",
      message: "stream disconnected during refresh",
    });
    const invalidations = Stream.unwrap(
      Ref.getAndUpdate(connectionAttempts, (count) => count + 1).pipe(
        Effect.map((count) =>
          count === 0
            ? Stream.fromEffect(Deferred.await(allowInvalidation)).pipe(
                Stream.concat(Stream.fail(disconnect)),
              )
            : Stream.make(undefined).pipe(Stream.concat(Stream.never)),
        ),
      ),
    );
    const read = Ref.getAndUpdate(snapshotReads, (count) => count + 1).pipe(
      Effect.flatMap((count) => {
        if (count === 0) {
          return Effect.succeed({ account, snippets: [firstSnippet] });
        }
        if (count === 1) {
          return Effect.never;
        }
        return Effect.succeed({ account, snippets: [secondSnippet] });
      }),
    );

    yield* Effect.gen(function* () {
      const lifetime = yield* AccountProductLifetime;
      yield* lifetime.enter("user_1");
      yield* Effect.yieldNow;
      expect(lifetime.getSnapshot()).toMatchObject({
        apiAvailability: "available",
        snippets: [firstSnippet],
      });

      yield* Deferred.succeed(allowInvalidation, undefined);
      yield* Effect.yieldNow;
      expect(lifetime.getSnapshot()).toMatchObject({
        liveConnection: "reconnecting",
        snippets: [firstSnippet],
      });

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(connectionAttempts)).toBe(2);
      expect(lifetime.getSnapshot()).toEqual({
        account,
        accountId: "user_1",
        apiAvailability: "available",
        kind: "ready",
        liveConnection: "connected",
        localReadPerformance: "degraded",
        snippets: [secondSnippet],
      });
    }).pipe(Effect.provide(Layer.merge(provideLifetime(read, invalidations), TestClock.layer())));
  }),
);

it.effect("preserves the last-confirmed collection when the API becomes unavailable", () =>
  Effect.gen(function* () {
    const nextInvalidation = yield* Deferred.make<void>();
    const reads = yield* Ref.make(0);
    const expectedSnippet = snippet("confirmed");
    const failure = new RpcError({
      code: "INTERNAL_SERVER_ERROR",
      message: "backend unavailable",
    });
    const read = Ref.getAndUpdate(reads, (count) => count + 1).pipe(
      Effect.flatMap((count) =>
        count < INITIAL_AND_CONNECTED_REFRESH_COUNT
          ? Effect.succeed({ account, snippets: [expectedSnippet] })
          : Effect.fail(failure),
      ),
    );
    const invalidations = Stream.make(undefined).pipe(
      Stream.concat(Stream.fromEffect(Deferred.await(nextInvalidation))),
      Stream.concat(Stream.never),
    );

    yield* Effect.gen(function* () {
      const lifetime = yield* AccountProductLifetime;
      yield* lifetime.enter("user_1");
      yield* Effect.yieldNow;
      yield* Deferred.succeed(nextInvalidation, undefined);
      yield* Effect.yieldNow;

      expect(lifetime.getSnapshot()).toEqual({
        account,
        accountId: "user_1",
        apiAvailability: "unavailable",
        cause: failure,
        kind: "ready",
        liveConnection: "connected",
        localReadPerformance: "degraded",
        snippets: [expectedSnippet],
      });
      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(reads)).toBe(3);
    }).pipe(Effect.provide(Layer.merge(provideLifetime(read, invalidations), TestClock.layer())));
  }),
);
