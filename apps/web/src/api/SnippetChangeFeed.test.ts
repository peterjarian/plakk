import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { snippetChangeRecoveryWakeStream, snippetChangeWakeStream } from "./SnippetChangeEvents.ts";
import { encodeSnippetChangeCursor, makeSnippetChangePage } from "./SnippetChangeFeed.ts";

const snippet: ApiSnippet = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  kind: "TEXT",
  title: "Text snippet",
  fileName: "0d1e2f3a-4567-4890-8abc-def012345678.txt",
  byteSize: 12,
  contentType: "text/plain; charset=utf-8",
  contentUrl: null,
  thumbnailUrl: null,
  textContent: null,
  storageProvider: "GOOGLE_DRIVE",
  uploadStatus: "READY",
  createdAt: "2026-07-10T20:00:00.000Z",
  updatedAt: "2026-07-10T20:00:01.000Z",
};

const changes = [
  {
    ownerWorkosUserId: "user-1",
    sequence: 1n,
    changeType: "UPSERT" as const,
    snippetId: snippet.id,
    snapshot: { ...snippet, uploadStatus: "UPLOADING" as const },
  },
  {
    ownerWorkosUserId: "user-1",
    sequence: 2n,
    changeType: "UPSERT" as const,
    snippetId: snippet.id,
    snapshot: snippet,
  },
];

describe("durable snippet change pages", () => {
  it("binds opaque cursors to one account", async () => {
    const result = await Effect.runPromise(
      makeSnippetChangePage({
        ownerWorkosUserId: "user-2",
        cursor: encodeSnippetChangeCursor("user-1", 0n),
        latestSequence: 0n,
        firstRetainedSequence: null,
        changes: [],
      }),
    );

    expect(result).toEqual({ status: "RESNAPSHOT_REQUIRED" });
  });

  it("never returns a change owned by another account", async () => {
    const result = await Effect.runPromise(
      makeSnippetChangePage({
        ownerWorkosUserId: "user-1",
        cursor: encodeSnippetChangeCursor("user-1", 0n),
        latestSequence: 1n,
        firstRetainedSequence: 1n,
        changes: [{ ...changes[0]!, ownerWorkosUserId: "user-2" }],
      }),
    );

    expect(result).toMatchObject({ status: "OK", changes: [] });
  });

  it("returns a bounded page that replays identically", async () => {
    const cursor = encodeSnippetChangeCursor("user-1", 0n);
    const input = {
      ownerWorkosUserId: "user-1",
      cursor,
      latestSequence: 2n,
      firstRetainedSequence: 1n,
      changes: changes.slice(0, 1),
    } as const;

    const [first, replay] = await Promise.all([
      Effect.runPromise(makeSnippetChangePage(input)),
      Effect.runPromise(makeSnippetChangePage(input)),
    ]);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "OK",
      changes: [{ type: "UPSERT", snippet: { uploadStatus: "UPLOADING" } }],
    });
    if (first.status === "OK") {
      expect(first.nextCursor).not.toBe(cursor);
    }
  });

  it("requires a fresh snapshot when retention passed the cursor", async () => {
    const result = await Effect.runPromise(
      makeSnippetChangePage({
        ownerWorkosUserId: "user-1",
        cursor: encodeSnippetChangeCursor("user-1", 0n),
        latestSequence: 2n,
        firstRetainedSequence: 2n,
        changes: changes.slice(1),
      }),
    );

    expect(result).toEqual({ status: "RESNAPSHOT_REQUIRED" });
  });

  it("publishes deletion tombstones", async () => {
    const result = await Effect.runPromise(
      makeSnippetChangePage({
        ownerWorkosUserId: "user-1",
        cursor: encodeSnippetChangeCursor("user-1", 2n),
        latestSequence: 3n,
        firstRetainedSequence: 1n,
        changes: [
          {
            ownerWorkosUserId: "user-1",
            sequence: 3n,
            changeType: "DELETE",
            snippetId: snippet.id,
            snapshot: null,
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      status: "OK",
      changes: [{ type: "DELETE", snippetId: snippet.id }],
    });
  });
});

describe("snippet change SSE wake-ups", () => {
  it("wakes immediately so a missed signal is recovered through the feed", async () => {
    const messages = await Effect.runPromise(
      snippetChangeWakeStream(Stream.empty, "user-1").pipe(Stream.runCollect),
    );

    expect(Array.from(messages)).toEqual(["event: changes-available\ndata:\n\n"]);
  });

  it("only wakes for the authenticated account", async () => {
    const messages = await Effect.runPromise(
      snippetChangeWakeStream(Stream.make("user-2", "user-1"), "user-1").pipe(Stream.runCollect),
    );

    expect(Array.from(messages)).toEqual([
      "event: changes-available\ndata:\n\n",
      "event: changes-available\ndata:\n\n",
    ]);
  });

  it("recovers a missed notification while the connection stays open", async () => {
    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* snippetChangeRecoveryWakeStream.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* TestClock.adjust("15 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(Array.from(messages)).toEqual(["event: changes-available\ndata:\n\n"]);
  });
});
