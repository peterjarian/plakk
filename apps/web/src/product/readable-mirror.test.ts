import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import {
  AccountProductMirror,
  AccountProductMirrorError,
  makeRuntimeFallbackAccountProductMirror,
  makeSessionMemoryAccountProductMirrorLayer,
} from "./readable-mirror.ts";
import {
  makeBrowserAccountProductMirrorLayer,
  supportsDurableReadableMirror,
} from "./browser-readable-mirror.ts";

const account: AccountStatus = {
  blockedReasons: [],
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
};

const snippet: ApiSnippet = {
  byteSize: 12,
  createdAt: "2026-07-27T00:00:00.000Z",
  fileName: "mirror.txt",
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  storageObjectId: "provider-object",
  storageProvider: "GOOGLE_DRIVE",
  updatedAt: "2026-07-27T00:00:01.000Z",
};

it.effect("session memory implements the readable mirror contract and purges account facts", () =>
  Effect.gen(function* () {
    const mirror = yield* AccountProductMirror;

    expect(mirror.readPerformance).toBe("degraded");
    expect(yield* mirror.read).toBeNull();

    yield* mirror.replace({ account, snippets: [snippet] });
    expect(yield* mirror.read).toEqual({ account, snippets: [snippet] });

    yield* mirror.purge;
    expect(yield* mirror.read).toBeNull();
  }).pipe(Effect.provide(makeSessionMemoryAccountProductMirrorLayer())),
);

it("requires every cooperative SQLite capability instead of sniffing a browser name", () => {
  const capable = {
    BroadcastChannel: class {},
    Worker: class {},
    navigator: {
      locks: { request: () => undefined },
      storage: { getDirectory: () => undefined },
    },
  };

  expect(supportsDurableReadableMirror(capable)).toBe(true);
  expect(
    supportsDurableReadableMirror({
      ...capable,
      navigator: { ...capable.navigator, storage: {} },
    }),
  ).toBe(false);
});

it.effect("forced capability failure keeps the product mirror available in session memory", () =>
  Effect.gen(function* () {
    const mirror = yield* AccountProductMirror;
    expect(mirror.readPerformance).toBe("degraded");
    yield* mirror.replace({ account, snippets: [snippet] });
    expect(yield* mirror.read).toEqual({ account, snippets: [snippet] });
  }).pipe(
    Effect.provide(
      makeBrowserAccountProductMirrorLayer("forced-memory-account", {
        forceSessionMemory: true,
      }),
    ),
  ),
);

it.effect("a runtime durable failure selects session memory for later operations", () =>
  Effect.gen(function* () {
    let purgeCalls = 0;
    const failure = new AccountProductMirrorError({
      cause: new Error("worker stopped"),
      reason: "Durable mirror failed.",
    });
    const mirror = makeRuntimeFallbackAccountProductMirror(
      AccountProductMirror.of({
        changes: Stream.never,
        purge: Effect.sync(() => {
          purgeCalls += 1;
        }),
        read: Effect.fail(failure),
        readPerformance: "accelerated",
        replace: () => Effect.fail(failure),
      }),
    );

    expect(yield* mirror.read.pipe(Effect.flip)).toBe(failure);
    yield* mirror.replace({ account, snippets: [snippet] });
    expect(yield* mirror.read).toEqual({ account, snippets: [snippet] });
    yield* mirror.purge;
    expect(purgeCalls).toBe(1);
    expect(yield* mirror.read).toBeNull();
  }),
);

it.effect("durable purge remains fail-closed after runtime fallback", () =>
  Effect.gen(function* () {
    const failure = new AccountProductMirrorError({
      cause: new Error("worker stopped"),
      reason: "Durable mirror failed.",
    });
    const mirror = makeRuntimeFallbackAccountProductMirror(
      AccountProductMirror.of({
        changes: Stream.never,
        purge: Effect.fail(failure),
        read: Effect.fail(failure),
        readPerformance: "accelerated",
        replace: () => Effect.fail(failure),
      }),
    );

    yield* mirror.read.pipe(Effect.flip);
    expect(yield* mirror.purge.pipe(Effect.flip)).toBe(failure);
  }),
);
