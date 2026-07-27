import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AccountProductMirror,
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
