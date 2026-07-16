import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { Tray } from "./Tray.tsx";

const state = vi.hoisted(() => {
  const latest = {
    id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
    fileName: "Alfa Romeo.png",
    byteSize: 61_700,
    storageProvider: "GOOGLE_DRIVE",
    storageObjectId: "drive-object",
    uploadStatus: "UPLOADED",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    localState: null,
    localTextContent: null,
    contentAvailable: true,
  } as const;
  return { latest, thumbnails: vi.fn(() => ({ [latest.id]: "blob:tray-preview" })) };
});

vi.mock("../hooks/useSnippetThumbnails.ts", () => ({
  useSnippetThumbnails: state.thumbnails,
}));

vi.mock("./tray/useTraySnippets.ts", () => ({
  useTraySnippets: () => ({
    addClipboard: vi.fn(),
    addDropped: vi.fn(),
    addText: vi.fn(),
    error: null,
    latest: state.latest,
    reportError: vi.fn(),
    upload: vi.fn(),
  }),
}));

describe("Tray", () => {
  it("projects the shared image thumbnail into its recent item", () => {
    const markup = renderToStaticMarkup(<Tray />);

    expect(state.thumbnails).toHaveBeenCalledWith([state.latest]);
    expect(markup).toContain('<img src="blob:tray-preview"');
  });
});
