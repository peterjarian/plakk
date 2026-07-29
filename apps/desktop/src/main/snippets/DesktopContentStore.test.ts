import { NodeFileSystem } from "@effect/platform-node";
import type { Snippet } from "@plakk/client-runtime";
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

const snippet = (byteSize: number): Snippet => ({
  id: snippetId,
  fileName: "notes.txt",
  byteSize,
  storageProvider: "GOOGLE_DRIVE",
  mediaType: "text/plain",
  storageObjectId: "object-1",
  status: "PUBLISHED",
  errorMessage: null,
  createdAt: "2026-07-20T18:00:00.000Z",
  updatedAt: "2026-07-20T18:00:00.000Z",
  localContentAvailability: { status: "AVAILABLE" },
});

describe("DesktopContentStore", () => {
  it.effect("provides the shared content store and the desktop text preview", () =>
    Effect.gen(function* () {
      const content = (yield* DesktopContentStore).forUser(userId);
      const bytes = new TextEncoder().encode("hello");

      yield* content.store.write(snippetId, bytes.byteLength, Stream.make(bytes));

      const stored = yield* content.store.read(snippetId).pipe(
        Stream.runCollect,
        Effect.map((chunks) => Uint8Array.from(Buffer.concat(chunks))),
      );
      expect(stored).toEqual(bytes);
      expect(yield* content.store.readRange(snippetId, 1, 3)).toEqual(
        new TextEncoder().encode("ell"),
      );
      expect(yield* content.store.entries).toEqual([{ snippetId, byteSize: bytes.byteLength }]);
      expect(yield* content.preview(snippet(bytes.byteLength))).toBe("hello");

      yield* content.store.remove([snippetId]);
      expect(yield* content.store.entries).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects and removes an incomplete stored stream", () =>
    Effect.gen(function* () {
      const content = (yield* DesktopContentStore).forUser(userId);
      const result = yield* content.store
        .write(snippetId, 4, Stream.make(new Uint8Array([1, 2])))
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(yield* content.store.entries).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps binary bytes available without exposing an invalid text preview", () =>
    Effect.gen(function* () {
      const content = (yield* DesktopContentStore).forUser(userId);
      const bytes = new Uint8Array([0xff, 0xff]);

      yield* content.store.write(snippetId, bytes.byteLength, Stream.make(bytes));

      expect(yield* content.preview(snippet(bytes.byteLength))).toBeNull();
      expect(yield* content.store.entries).toEqual([{ snippetId, byteSize: bytes.byteLength }]);
    }).pipe(Effect.provide(layer)),
  );
});
