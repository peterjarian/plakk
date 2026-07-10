import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { getCachedSnippetContent, removeCachedSnippet } from "./snippetCache.ts";

describe("snippet cache", () => {
  it("keeps downloaded bytes in a user-scoped cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "plakk-snippet-cache-"));
    const download = async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      kind: "IMAGE" as const,
      fileName: "photo.png",
      contentType: null,
    });

    try {
      const first = await getCachedSnippetContent({
        root,
        userId: "user-a",
        snippetId: "45d868d1-6942-4ef0-a6a6-2d6d0d0d0d0d",
        download,
      });
      const second = await getCachedSnippetContent({
        root,
        userId: "user-a",
        snippetId: "45d868d1-6942-4ef0-a6a6-2d6d0d0d0d0d",
        download: async () => {
          throw new Error("should use the cache");
        },
      });

      expect(Array.from(first.bytes)).toEqual([1, 2, 3]);
      expect(Array.from(second.bytes)).toEqual([1, 2, 3]);
      expect(second).toMatchObject({
        kind: "IMAGE",
        fileName: "photo.png",
        contentType: "image/png",
      });
      expect(second.path).toContain("user-a");

      await removeCachedSnippet({
        root,
        userId: "user-a",
        snippetId: "45d868d1-6942-4ef0-a6a6-2d6d0d0d0d0d",
      });
      const refreshed = await getCachedSnippetContent({
        root,
        userId: "user-a",
        snippetId: "45d868d1-6942-4ef0-a6a6-2d6d0d0d0d0d",
        download: async () => ({
          bytes: new Uint8Array([4]),
          kind: "IMAGE",
          fileName: "photo.png",
          contentType: null,
        }),
      });
      expect(Array.from(refreshed.bytes)).toEqual([4]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
