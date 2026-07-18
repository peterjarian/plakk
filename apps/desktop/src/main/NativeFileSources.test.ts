import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { NativeFileSourcesLive } from "./Layers/NativeFileSources.ts";
import { NativeFileSources } from "./Services/NativeFileSources.ts";

describe("NativeFileSources", () => {
  it.effect("resolves an opaque source exactly once", () =>
    NativeFileSources.use((sources) => {
      const sourceId = sources.register("/private/native/file.txt");
      return Effect.sync(() => {
        const first = sources.take(sourceId);
        const second = sources.take(sourceId);
        expect(sourceId).not.toContain("/private/native/file.txt");
        expect(first).toEqual({ filePath: "/private/native/file.txt", temporary: false });
        expect(second).toBeUndefined();
      });
    }).pipe(Effect.provide(NativeFileSourcesLive)),
  );

  it.effect("invalidates all sources and returns temporary files for cleanup", () =>
    NativeFileSources.use((sources) => {
      const native = sources.register("/private/native/file.txt");
      const temporary = sources.register("/tmp/pasted.png", { temporary: true });
      return Effect.sync(() => {
        expect(sources.discardAll()).toEqual(["/tmp/pasted.png"]);
        expect(sources.take(native)).toBeUndefined();
        expect(sources.take(temporary)).toBeUndefined();
      });
    }).pipe(Effect.provide(NativeFileSourcesLive)),
  );
});
