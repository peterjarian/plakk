import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Layer, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { AccountProductLifetime, clearProductThenSignOut } from "./account-product-lifetime.ts";
import { AccountProductReader, type AccountProductSnapshot } from "./product-reader.ts";

const account: AccountStatus = {
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
  blockedReasons: [],
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

const provideLifetime = (
  read: AccountProductReader["Service"]["read"],
  invalidations: AccountProductReader["Service"]["invalidations"] = Stream.make(undefined).pipe(
    Stream.concat(Stream.never),
  ),
) =>
  AccountProductLifetime.layer.pipe(
    Layer.provide(
      Layer.succeed(AccountProductReader, AccountProductReader.of({ invalidations, read })),
    ),
  );

class PurgeFailure extends Data.TaggedError("PurgeFailure") {}

describe("account product lifetime", () => {
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
        snippets: count < 2 ? [firstSnippet] : [secondSnippet],
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
        snippets: count < 2 ? [firstSnippet] : [secondSnippet],
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
        count < 2 ? Effect.succeed({ account, snippets: [expectedSnippet] }) : Effect.fail(failure),
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
        snippets: [expectedSnippet],
      });
      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(reads)).toBe(3);
    }).pipe(Effect.provide(Layer.merge(provideLifetime(read, invalidations), TestClock.layer())));
  }),
);
