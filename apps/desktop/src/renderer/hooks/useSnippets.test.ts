import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Snippet } from "@plakk/client-runtime";

import { createImageUrlRegistry, projectSnippetReadModels } from "./useSnippets.ts";

const snippet = (input: Partial<Snippet> = {}): Snippet =>
  ({
    id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
    fileName: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0.txt",
    byteSize: 24,
    storageProvider: "GOOGLE_DRIVE",
    mediaType: "text/plain",
    storageObjectId: null,
    status: "UPLOADING",
    errorMessage: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    localContentAvailability: { status: "AVAILABLE" },
    ...input,
  }) as Snippet;

describe("snippet read-model projection", () => {
  it("uses durable local text as the immediate presentation", () => {
    const [item] = projectSnippetReadModels([snippet({ title: "A stable local snippet" })], {});

    expect(item?.presentation).toEqual({ type: "text", title: "A stable local snippet" });
  });

  it("uses a stored title without reading content", () => {
    const remoteText = snippet({
      title: "A stable title",
      status: "PUBLISHED",
      storageObjectId: "object-1",
      localContentAvailability: { status: "NOT_AVAILABLE" },
    });

    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({ type: "text", title: "A stable title" });
  });

  it("projects a stored hyperlink title", () => {
    const remoteText = snippet({
      title: "https://plakk.app",
      status: "PUBLISHED",
      storageObjectId: "object-1",
    });
    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({
      type: "hyperlink",
      title: "https://plakk.app",
      url: "https://plakk.app",
    });
  });

  it("uses the file name when a non-text snippet has no title", () => {
    const file = snippet({
      fileName: "archive.zip",
      mediaType: "application/zip",
    });
    const [item] = projectSnippetReadModels([file], {});

    expect(item?.presentation).toEqual({ type: "file", title: "archive.zip" });
  });
});

describe("image URL registry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses URLs and revokes them when images leave or the registry is disposed", () => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const registry = createImageUrlRegistry();

    expect(registry.create("first", Uint8Array.from([1, 2, 3]))).toBe("blob:first");
    expect(registry.create("first", Uint8Array.from([4, 5, 6]))).toBe("blob:first");
    expect(registry.create("second", Uint8Array.from([7, 8, 9]))).toBe("blob:second");
    expect(createObjectURL).toHaveBeenCalledTimes(2);

    expect(registry.retain(new Set(["second"]))).toEqual(["first"]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");

    registry.dispose();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second");
  });
});
