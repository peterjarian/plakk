import { describe, expect, it } from "vite-plus/test";
import { Effect, Stream } from "effect";

import { decodeSnippetInvalidations } from "./SnippetRemoteTransportLive.ts";

describe("Snippet SSE transport", () => {
  it("decodes fragmented payload-free invalidations and ignores keep-alive comments", async () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const events = await Effect.runPromise(
      decodeSnippetInvalidations(
        Stream.make(
          encode(": keep-alive\n\ndata: SNIPP"),
          encode("ETS_CHANGED\n\ndata: IGNORED\n\ndata: SNIPPETS_CHANGED\n\n"),
        ),
      ).pipe(Stream.runCollect),
    );

    expect(Array.from(events)).toEqual([undefined, undefined]);
  });
});
