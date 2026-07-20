import type { DrizzleService } from "@plakk/db";
import { SNIPPETS_CHANGED } from "@plakk/shared/PlakkApi";
import { describe, expect, it } from "vite-plus/test";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  makeSnippetEventsResponse,
  notifySnippetChanges,
  snippetEventBytes,
  snippetInvalidationStream,
} from "./snippetInvalidations.ts";

describe("snippet invalidations", () => {
  it("emits one payload-free refresh signal on connect and only for the authenticated account", async () => {
    const events = await Effect.runPromise(
      snippetInvalidationStream(Stream.make("account-2", "account-1"), "account-1").pipe(
        Stream.runCollect,
      ),
    );

    expect(Array.from(events)).toEqual([SNIPPETS_CHANGED, SNIPPETS_CHANGED]);
  });

  it("renders a long-lived SSE response with lightweight transport keep-alive", async () => {
    const chunks = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* snippetEventBytes(Stream.never, "account-1").pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* TestClock.adjust("15 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(new Set(Array.from(chunks, (chunk) => new TextDecoder().decode(chunk)))).toEqual(
      new Set([`data: ${SNIPPETS_CHANGED}\n\n`, ": keep-alive\n\n"]),
    );
    expect(makeSnippetEventsResponse(Stream.never, "account-1").headers["content-type"]).toBe(
      "text/event-stream",
    );
  });

  it("stages the internal account notification through the supplied transaction", async () => {
    const statements: Array<unknown> = [];
    const db = {
      execute: (statement: unknown) =>
        Effect.sync(() => {
          statements.push(statement);
        }),
    } as unknown as Pick<DrizzleService["db"], "execute">;

    await Effect.runPromise(notifySnippetChanges(db, "account-1"));

    expect(statements).toHaveLength(1);
    expect(JSON.stringify(statements[0])).toContain("account-1");
  });
});
