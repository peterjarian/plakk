import type { ClientSnapshot, Snippet } from "@plakk/client-runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createImageUrlRegistry, projectSnippetReadModels, useSnippets } from "./useSnippets.ts";

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

const clientSnapshot = (
  syncStatus: ClientSnapshot["syncStatus"],
  snippets: ReadonlyArray<Snippet> = [],
): ClientSnapshot => ({
  user: {
    id: "user-1",
    firstName: "Test",
    lastName: "User",
    email: "test@example.com",
    createdAt: "2026-07-20T18:00:00.000Z",
    updatedAt: "2026-07-20T18:00:00.000Z",
  },
  capability: {
    status: "OFFLINE",
    storageProvider: { known: false, value: null },
  },
  syncStatus,
  storageUsageBytes: 0,
  snippets,
});

const projectHook = (snapshot: ClientSnapshot) => {
  let result: ReturnType<typeof useSnippets> | undefined;
  function Harness() {
    result = useSnippets({
      loading: false,
      snapshot,
      run: vi.fn() as never,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return result!;
};

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

describe("snippet loading projection", () => {
  it("keeps an empty list loading until the initial remote sync settles", () => {
    expect(projectHook(clientSnapshot("STARTING")).isLoading).toBe(true);
    expect(projectHook(clientSnapshot("CONNECTED")).isLoading).toBe(false);
    expect(projectHook(clientSnapshot("STARTING", [snippet()])).isLoading).toBe(false);
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
