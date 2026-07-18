import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { NativeFileSources } from "./NativeFileSources.ts";
import { NativeFileSourcesLive } from "./NativeFileSourcesLive.ts";

describe("NativeFileSources", () => {
  it.effect("resolves an opaque source exactly once", () =>
    NativeFileSources.use((sources) =>
      Effect.gen(function* () {
        const sourceId = yield* sources.register("/private/native/file.txt");
        const first = sources.take(sourceId);
        const second = sources.take(sourceId);
        expect(sourceId).not.toContain("/private/native/file.txt");
        expect(first).toEqual({ filePath: "/private/native/file.txt", temporary: false });
        expect(second).toBeUndefined();
      }),
    ).pipe(Effect.provide(NativeFileSourcesLive.pipe(Layer.provide(NodeCrypto.layer)))),
  );

  it.effect("invalidates all sources and returns temporary files for cleanup", () =>
    NativeFileSources.use((sources) =>
      Effect.gen(function* () {
        const native = yield* sources.register("/private/native/file.txt");
        const temporary = yield* sources.register("/tmp/pasted.png", { temporary: true });
        expect(sources.discardAll()).toEqual(["/tmp/pasted.png"]);
        expect(sources.take(native)).toBeUndefined();
        expect(sources.take(temporary)).toBeUndefined();
      }),
    ).pipe(Effect.provide(NativeFileSourcesLive.pipe(Layer.provide(NodeCrypto.layer)))),
  );
});
