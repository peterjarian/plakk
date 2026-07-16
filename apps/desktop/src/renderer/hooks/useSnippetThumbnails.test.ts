import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hookState = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  thumbnailUrls: {} as Record<string, string>,
}));

vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hookState.cleanups.push(cleanup);
  },
  useRef: <A>(value: A) => ({ current: value }),
  useState: <A>(value: A) => [
    value,
    (update: A | ((current: A) => A)) => {
      const current = hookState.thumbnailUrls as A;
      hookState.thumbnailUrls = (
        typeof update === "function" ? (update as (current: A) => A)(current) : update
      ) as Record<string, string>;
    },
  ],
}));

const imageSnippet = {
  id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
  fileName: "Alfa Romeo.png",
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-object",
  uploadStatus: "UPLOADED",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  localState: null,
  localTextContent: null,
  contentAvailable: true,
} as const;

describe("useSnippetThumbnails", () => {
  beforeEach(() => {
    hookState.cleanups.length = 0;
    hookState.thumbnailUrls = {};
  });

  it("reads an available image and owns its object URL lifecycle", async () => {
    const read = vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3, 4]));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { ipc: { snippets: { read } } },
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const { useSnippetThumbnails } = await import("./useSnippetThumbnails.ts");

    useSnippetThumbnails([imageSnippet]);

    await vi.waitFor(() =>
      expect(hookState.thumbnailUrls).toEqual({ [imageSnippet.id]: "blob:preview" }),
    );
    expect(read).toHaveBeenCalledWith(imageSnippet.id);
    expect(createObjectURL).toHaveBeenCalledOnce();

    for (const cleanup of hookState.cleanups) cleanup();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
});
