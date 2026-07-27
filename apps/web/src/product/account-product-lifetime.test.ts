import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Layer, Ref } from "effect";

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

const provideLifetime = (read: AccountProductReader["Service"]["read"]) =>
  AccountProductLifetime.layer.pipe(
    Layer.provide(Layer.succeed(AccountProductReader, AccountProductReader.of({ read }))),
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
        kind: "ready",
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
          kind: "ready",
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
          kind: "ready",
          snippets: [],
        });
      }).pipe(Effect.provide(provideLifetime(read)));
    }),
  );

  it.effect("cleans product data before credential sign-out and fails closed", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      yield* clearProductThenSignOut(
        Effect.sync(() => void order.push("clear")),
        Effect.sync(() => void order.push("sign-out")),
      );
      expect(order).toEqual(["clear", "sign-out"]);

      const signOutCalled = yield* Ref.make(false);
      const failure = yield* clearProductThenSignOut(
        Effect.fail(new PurgeFailure()),
        Ref.set(signOutCalled, true),
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PurgeFailure);
      expect(yield* Ref.get(signOutCalled)).toBe(false);
    }),
  );
});
