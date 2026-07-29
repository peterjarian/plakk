import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result, Stream } from "effect";

import { DesktopContentStore, makeDesktopContentStoreLayer } from "./DesktopContentStore.ts";

const userId = "user-1";
const snippetId = "0d1e2f3a-4567-4890-8abc-def012345678";

const layer = Layer.unwrap(
  FileSystem.FileSystem.use((fileSystem) =>
    fileSystem
      .makeTempDirectoryScoped({ prefix: "plakk-content-" })
      .pipe(Effect.map((root) => makeDesktopContentStoreLayer(root))),
  ),
).pipe(Layer.provide(NodeFileSystem.layer));

describe("DesktopContentStore", () => {
  it.effect("provides the shared content store", () =>
    Effect.gen(function* () {
      const content = (yield* DesktopContentStore).forUser(userId);
      const bytes = new TextEncoder().encode("hello");

      yield* content.write(snippetId, bytes.byteLength, Stream.make(bytes));

      const stored = yield* content.read(snippetId).pipe(
        Stream.runCollect,
        Effect.map((chunks) => Uint8Array.from(Buffer.concat(chunks))),
      );
      expect(stored).toEqual(bytes);
      expect(yield* content.readRange(snippetId, 1, 3)).toEqual(new TextEncoder().encode("ell"));
      expect(yield* content.entries).toEqual([{ snippetId, byteSize: bytes.byteLength }]);

      yield* content.remove([snippetId]);
      expect(yield* content.entries).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects and removes an incomplete stored stream", () =>
    Effect.gen(function* () {
      const content = (yield* DesktopContentStore).forUser(userId);
      const result = yield* content
        .write(snippetId, 4, Stream.make(new Uint8Array([1, 2])))
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(yield* content.entries).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps binary bytes available", () =>
    Effect.gen(function* () {
      const content = (yield* DesktopContentStore).forUser(userId);
      const bytes = new Uint8Array([0xff, 0xff]);

      yield* content.write(snippetId, bytes.byteLength, Stream.make(bytes));

      expect(yield* content.entries).toEqual([{ snippetId, byteSize: bytes.byteLength }]);
    }).pipe(Effect.provide(layer)),
  );
});
