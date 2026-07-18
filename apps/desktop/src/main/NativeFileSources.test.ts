import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";

import { NativeFileSources } from "./NativeFileSources.ts";

describe("NativeFileSources", () => {
  it("resolves an opaque source exactly once", async () => {
    const result = await Effect.runPromise(
      NativeFileSources.use((sources) => {
        const sourceId = sources.register("/private/native/file.txt");
        return Effect.succeed({
          sourceId,
          first: sources.take(sourceId),
          second: sources.take(sourceId),
        });
      }).pipe(Effect.provide(NativeFileSources.Live)),
    );

    expect(result.sourceId).not.toContain("/private/native/file.txt");
    expect(result.first).toEqual({ filePath: "/private/native/file.txt", temporary: false });
    expect(result.second).toBeUndefined();
  });

  it("invalidates all sources and returns temporary files for cleanup", async () => {
    const result = await Effect.runPromise(
      NativeFileSources.use((sources) => {
        const native = sources.register("/private/native/file.txt");
        const temporary = sources.register("/tmp/pasted.png", { temporary: true });
        return Effect.succeed({
          discarded: sources.discardAll(),
          native: sources.take(native),
          temporary: sources.take(temporary),
        });
      }).pipe(Effect.provide(NativeFileSources.Live)),
    );

    expect(result.discarded).toEqual(["/tmp/pasted.png"]);
    expect(result.native).toBeUndefined();
    expect(result.temporary).toBeUndefined();
  });
});
