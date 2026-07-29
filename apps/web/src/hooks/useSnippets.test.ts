import type { Snippet } from "@plakk/client-runtime";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createImageUrlRegistry, projectSnippetReadModels } from "./useSnippets.ts";

const snippet = (input: Partial<Snippet> = {}): Snippet =>
  ({
    id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
    fileName: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0.txt",
    byteSize: 24,
    storageProvider: "GOOGLE_DRIVE",
    mediaType: "text/plain",
    storageObjectId: "object-1",
    status: "PUBLISHED",
    errorMessage: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    localContentAvailability: { status: "NOT_AVAILABLE" },
    ...input,
  }) as Snippet;

describe("snippet read-model projection", () => {
  it("returns the same stable read model used by the desktop", () => {
    const source = snippet();
    const [item] = projectSnippetReadModels(
      [source],
      { [source.id]: "https://plakk.app" },
      { [source.id]: "blob:preview" },
    );

    expect(item).toEqual({
      id: source.id,
      fileName: source.fileName,
      byteSize: source.byteSize,
      createdAt: source.createdAt,
      kind: "PUBLISHED",
      localState: null,
      localContentAvailability: source.localContentAvailability,
      localTextPreview: "https://plakk.app",
      presentation: {
        type: "hyperlink",
        title: "https://plakk.app",
        url: "https://plakk.app",
      },
      thumbnailUrl: "blob:preview",
    });
  });

  it("does not expose a user-named text file before its content is decoded", () => {
    const [item] = projectSnippetReadModels([snippet({ fileName: "private-notes.md" })], {}, {});

    expect(item?.presentation).toEqual({ type: "file", title: "Text snippet" });
    expect(item?.localTextPreview).toBeNull();
  });

  it("withholds pulled text while its presentation is downloading", () => {
    const items = projectSnippetReadModels(
      [snippet({ localContentAvailability: { status: "DOWNLOADING" } })],
      {},
      {},
    );

    expect(items).toEqual([]);
  });
});

describe("image URL registry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses and revokes image URLs", () => {
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const registry = createImageUrlRegistry();

    expect(registry.create("first", Uint8Array.from([1]))).toBe("blob:first");
    expect(registry.create("first", Uint8Array.from([2]))).toBe("blob:first");
    expect(registry.create("second", Uint8Array.from([3]))).toBe("blob:second");
    expect(registry.retain(new Set(["second"]))).toEqual(["first"]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");

    registry.dispose();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second");
  });
});
