import { describe, expect, it } from "vite-plus/test";
import { Effect, Stream } from "effect";

import { decodeSnippetEvents, snippetEventsUrlFromRpcUrl } from "./SnippetRemoteTransportLive.ts";

describe("Snippet SSE transport", () => {
  it("derives the events endpoint beside the configured RPC endpoint", () => {
    expect(snippetEventsUrlFromRpcUrl("http://localhost:3100/api/rpc")).toBe(
      "http://localhost:3100/api/snippets/events",
    );
    expect(snippetEventsUrlFromRpcUrl("/api/rpc")).toBe("/api/snippets/events");
  });

  it("decodes fragmented payload-free invalidations and ignores keep-alive comments", async () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const events = await Effect.runPromise(
      decodeSnippetEvents(
        Stream.make(
          encode(": keep-alive\n\ndata: SNIPP"),
          encode("ETS_CHANGED\n\ndata: IGNORED\n\ndata: SNIPPETS_CHANGED\n\n"),
        ),
      ).pipe(Stream.runCollect),
    );

    expect(Array.from(events)).toEqual([undefined, undefined]);
  });
});
