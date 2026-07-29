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
    const source = snippet({ title: "https://plakk.app" });
    const [item] = projectSnippetReadModels([source], { [source.id]: "blob:preview" });

    expect(item).toEqual({
      id: source.id,
      fileName: source.fileName,
      byteSize: source.byteSize,
      createdAt: source.createdAt,
      kind: "PUBLISHED",
      localState: null,
      localContentAvailability: source.localContentAvailability,
      presentation: {
        type: "hyperlink",
        title: "https://plakk.app",
        url: "https://plakk.app",
      },
      thumbnailUrl: "blob:preview",
    });
  });

  it("uses a stored title immediately", () => {
    const source = snippet({ title: "A stable title" });
    const [item] = projectSnippetReadModels([source], {});

    expect(item?.presentation).toEqual({ type: "text", title: "A stable title" });
  });

  it("uses the file name when a non-text snippet has no title", () => {
    const source = snippet({ fileName: "archive.zip", mediaType: "application/zip" });
    const [item] = projectSnippetReadModels([source], {});

    expect(item?.presentation).toEqual({ type: "file", title: "archive.zip" });
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
