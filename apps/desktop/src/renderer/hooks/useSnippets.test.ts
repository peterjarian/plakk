import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DesktopSnippet } from "../../ipc/contracts.ts";
import {
  createImageUrlRegistry,
  initialSnippetSubscriptionState,
  projectSnippetReadModels,
  updateSnippetSubscription,
} from "./useSnippets.ts";

const snippet = (input: Partial<DesktopSnippet> = {}): DesktopSnippet => ({
  id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
  fileName: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0.txt",
  byteSize: 24,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: null,
  uploadStatus: null,
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  localState: { phase: "QUEUED", progress: 0, errorMessage: null, canRetry: false },
  localTextContent: "A stable local snippet",
  contentAvailable: true,
  ...input,
});

describe("snippet subscription transitions", () => {
  it("uses a controlled list error and recovers when a retry succeeds", () => {
    const loading = updateSnippetSubscription(initialSnippetSubscriptionState, {
      type: "load-started",
    });
    const failed = updateSnippetSubscription(loading, {
      type: "load-failed",
      requestRevision: 0,
    });

    expect(failed).toMatchObject({
      isLoading: false,
      error: "Couldn’t load snippets. Try again.",
    });

    const retrying = updateSnippetSubscription(failed, { type: "load-started" });
    const recovered = updateSnippetSubscription(retrying, {
      type: "load-succeeded",
      items: [snippet()],
      requestRevision: 0,
    });

    expect(recovered).toMatchObject({ isLoading: false, error: null, items: [snippet()] });
  });

  it("never lets a stale initial list result replace a newer change event", () => {
    const eventSnippet = snippet({ localTextContent: "From the change event" });
    const changed = updateSnippetSubscription(initialSnippetSubscriptionState, {
      type: "changed",
      items: [eventSnippet],
    });
    const staleList = updateSnippetSubscription(changed, {
      type: "load-succeeded",
      items: [snippet({ localTextContent: "From the stale list" })],
      requestRevision: 0,
    });

    expect(staleList).toMatchObject({ items: [eventSnippet], error: null });
  });
});

describe("snippet read-model projection", () => {
  it("uses durable local text as the immediate presentation", () => {
    const [item] = projectSnippetReadModels([snippet()], {}, {});

    expect(item?.presentation).toEqual({ type: "text", title: "A stable local snippet" });
    expect(item?.textContent).toEqual({ state: "ready", text: "A stable local snippet" });
  });

  it("does not expose an uploaded remote text row before hydration", () => {
    const remoteText = snippet({
      localState: null,
      localTextContent: null,
      storageObjectId: "remote-text",
      uploadStatus: "UPLOADED",
    });

    expect(projectSnippetReadModels([remoteText], {}, {})).toEqual([]);
  });

  it("replaces the hidden remote row with decoded content without a filename intermediate", () => {
    const remoteText = snippet({
      localState: null,
      localTextContent: null,
      storageObjectId: "remote-text",
      uploadStatus: "UPLOADED",
    });
    const [item] = projectSnippetReadModels(
      [remoteText],
      { [remoteText.id]: { state: "ready", text: "https://plakk.app" } },
      {},
    );

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
      localTextContent: null,
      storageObjectId: "remote-text",
      uploadStatus: "UPLOADED",
    });
    const [item] = projectSnippetReadModels(
      [remoteText],
      { [remoteText.id]: { state: "ready", text: "   " } },
      {},
    );

    expect(item?.presentation).toEqual({ type: "text", title: "Text snippet" });
    expect(item?.presentation.title).not.toContain(remoteText.id);
  });

  it("shows a controlled actionable row when remote text hydration fails", () => {
    const remoteText = snippet({
      localState: null,
      localTextContent: null,
      storageObjectId: "remote-text",
      uploadStatus: "UPLOADED",
    });
    const [item] = projectSnippetReadModels(
      [remoteText],
      {
        [remoteText.id]: { state: "failed", message: "Couldn’t load this text. Try again." },
      },
      {},
    );

    expect(item?.presentation).toEqual({ type: "text", title: "Text unavailable" });
    expect(item?.textContent).toEqual({
      state: "failed",
      message: "Couldn’t load this text. Try again.",
    });
    expect(JSON.stringify(item)).not.toContain("Loading text");
    expect(item?.presentation.title).not.toContain(remoteText.id);
  });

  it("keeps a remote in-progress text row honest without inventing decoded content", () => {
    const remoteText = snippet({
      localState: null,
      localTextContent: null,
      storageObjectId: null,
      uploadStatus: "UPLOADING",
      contentAvailable: false,
    });
    const [item] = projectSnippetReadModels([remoteText], {}, {});

    expect(item?.presentation).toEqual({ type: "text", title: "Text snippet" });
    expect(item?.textContent).toBeUndefined();
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
