import { SNIPPET_INVALIDATION_KEEP_ALIVE, SNIPPETS_CHANGED } from "@plakk/shared/PlakkApi";
import { describe, expect, it } from "vite-plus/test";
import { Effect, Stream } from "effect";

import { selectSnippetInvalidations } from "./SnippetRemoteTransportLive.ts";

describe("Snippet invalidation RPC transport", () => {
  it("projects change events and ignores keep-alives", async () => {
    const events = await Effect.runPromise(
      selectSnippetInvalidations(
        Stream.make(
          SNIPPET_INVALIDATION_KEEP_ALIVE,
          SNIPPETS_CHANGED,
          SNIPPET_INVALIDATION_KEEP_ALIVE,
          SNIPPETS_CHANGED,
        ),
      ).pipe(Stream.runCollect),
    );

    expect(Array.from(events)).toEqual([undefined, undefined]);
  });
});
