import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DesktopSnippet } from "../../ipc/contracts.ts";
import { createImageUrlRegistry, projectSnippetReadModels } from "./useSnippets.ts";

const snippet = (input: Partial<DesktopSnippet> = {}): DesktopSnippet => ({
  id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
  fileName: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0.txt",
  byteSize: 24,
  storageProvider: "GOOGLE_DRIVE",
  uploadStatus: null,
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  localState: { phase: "QUEUED", progress: 0, errorMessage: null, canRetry: false },
  localTextPreview: "A stable local snippet",
  localContentAvailability: { status: "AVAILABLE" },
  ...input,
});

describe("snippet read-model projection", () => {
  it("uses durable local text as the immediate presentation", () => {
    const [item] = projectSnippetReadModels([snippet()], {});

    expect(item?.presentation).toEqual({ type: "text", title: "A stable local snippet" });
  });

  it("projects a neutral file row before local text content is available", () => {
    const remoteText = snippet({
      localState: null,
      localTextPreview: null,
      uploadStatus: "UPLOADED",
      localContentAvailability: { status: "DOWNLOADING" },
    });

    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({ type: "file", title: "Text snippet" });
    expect(item?.presentation.title).not.toContain(remoteText.id);
    expect(JSON.stringify(item)).not.toContain("Loading text");
  });

  it("does not expose a user-named text file before its content is decoded", () => {
    const remoteText = snippet({
      fileName: "private-notes.md",
      localState: null,
      localTextPreview: null,
      uploadStatus: "UPLOADED",
      localContentAvailability: { status: "NOT_AVAILABLE" },
    });

    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({ type: "file", title: "Text snippet" });
    expect(item?.presentation.title).not.toContain("private-notes.md");
  });

  it("projects decoded managed content atomically without a filename intermediate", () => {
    const remoteText = snippet({
      localState: null,
      uploadStatus: "UPLOADED",
      localTextPreview: "https://plakk.app",
      localContentAvailability: { status: "AVAILABLE" },
    });
    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({
      type: "hyperlink",
      title: "https://plakk.app",
      url: "https://plakk.app",
    });
    expect(item?.presentation.title).not.toContain(remoteText.id);
  });

  it("never uses the generated package name when decoded text has no title", () => {
    const remoteText = snippet({
      localState: null,
      uploadStatus: "UPLOADED",
      localTextPreview: "   ",
      localContentAvailability: { status: "AVAILABLE" },
    });
    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({ type: "text", title: "Text snippet" });
    expect(item?.presentation.title).not.toContain(remoteText.id);
  });

  it("shows a controlled actionable row when remote text hydration fails", () => {
    const remoteText = snippet({
      localState: null,
      localTextPreview: null,
      uploadStatus: "UPLOADED",
      localContentAvailability: {
        status: "FAILED",
        message: "Couldn’t download this text. Try again.",
      },
    });
    const [item] = projectSnippetReadModels([remoteText], {});

    expect(item?.presentation).toEqual({ type: "file", title: "Text snippet" });
    expect(JSON.stringify(item)).not.toContain("Loading text");
    expect(item?.presentation.title).not.toContain(remoteText.id);
  });

  it("keeps a remote in-progress text row honest without inventing decoded content", () => {
    const remoteText = snippet({
      localState: null,
      localTextPreview: null,
      uploadStatus: "UPLOADING",
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
