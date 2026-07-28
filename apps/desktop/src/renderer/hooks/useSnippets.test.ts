import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Snippet } from "@plakk/client-runtime";

import type { DesktopSnippet } from "../../ipc/contracts.ts";
import { createImageUrlRegistry, projectSnippetReadModels } from "./useSnippets.ts";

const snippet = (
  input: Partial<Snippet> & { readonly localTextPreview?: string | null } = {},
): DesktopSnippet => {
  const { localTextPreview = "A stable local snippet", ...snippetInput } = input;
  return {
    snippet: {
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
      ...snippetInput,
    } as Snippet,
    localTextPreview,
  };
};

describe("snippet read-model projection", () => {
  it("uses durable local text as the immediate presentation", () => {
    const [item] = projectSnippetReadModels([snippet()], {});

    expect(item?.presentation).toEqual({ type: "text", title: "A stable local snippet" });
  });

  it("withholds pulled text until its local presentation is available", () => {
    const remoteText = snippet({
      localTextPreview: null,
      status: "PUBLISHED",
      storageObjectId: "object-1",
      localContentAvailability: { status: "DOWNLOADING" },
    });

    const items = projectSnippetReadModels([remoteText], {});

    expect(items).toEqual([]);
  });

  it("does not expose a user-named text file before its content is decoded", () => {
    const remoteText = snippet({
      fileName: "private-notes.md",
      localTextPreview: null,
      status: "PUBLISHED",
      storageObjectId: "object-1",
      localContentAvailability: { status: "NOT_AVAILABLE" },
    });

    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({ type: "file", title: "Text snippet" });
    expect(item?.presentation.title).not.toContain("private-notes.md");
  });

  it("projects decoded managed content atomically without a filename intermediate", () => {
    const remoteText = snippet({
      status: "PUBLISHED",
      storageObjectId: "object-1",
      localTextPreview: "https://plakk.app",
      localContentAvailability: { status: "AVAILABLE" },
    });
    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({
      type: "hyperlink",
      title: "https://plakk.app",
      url: "https://plakk.app",
    });
    expect(item?.presentation.title).not.toContain(remoteText.snippet.id);
  });

  it("never uses the generated package name when decoded text has no title", () => {
    const remoteText = snippet({
      status: "PUBLISHED",
      storageObjectId: "object-1",
      localTextPreview: "   ",
      localContentAvailability: { status: "AVAILABLE" },
    });
    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({ type: "text", title: "Text snippet" });
    expect(item?.presentation.title).not.toContain(remoteText.snippet.id);
  });

  it("shows a controlled actionable row when remote text hydration fails", () => {
    const remoteText = snippet({
      localTextPreview: null,
      status: "PUBLISHED",
      storageObjectId: "object-1",
      localContentAvailability: {
        status: "FAILED",
        message: "Couldn’t download this text. Try again.",
      },
    });
    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({ type: "file", title: "Text snippet" });
    expect(JSON.stringify(item)).not.toContain("Loading text");
    expect(item?.presentation.title).not.toContain(remoteText.snippet.id);
  });

  it("keeps a local in-progress text row honest without inventing decoded content", () => {
    const remoteText = snippet({
      localTextPreview: null,
      localContentAvailability: { status: "NOT_AVAILABLE" },
    });
    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({ type: "file", title: "Text snippet" });
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
