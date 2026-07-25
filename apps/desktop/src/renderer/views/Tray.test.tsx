import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { Tray } from "./Tray.tsx";

const state = vi.hoisted(() => {
  const latest = {
    id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
    fileName: "Alfa Romeo.png",
    byteSize: 61_700,
    storageProvider: "GOOGLE_DRIVE",
    kind: "PUBLISHED",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    localState: null,
    localTextPreview: null,
    localContentAvailability: { status: "AVAILABLE" },
    presentation: { type: "image", title: "Alfa Romeo.png" },
    thumbnailUrl: "blob:tray-preview",
  } as const;
  return { latest };
});

vi.mock("../hooks/useSnippets.ts", () => ({
  useSnippets: () => ({
    error: null,
    isLoading: false,
    items: [state.latest],
    reload: vi.fn(),
  }),
}));

vi.mock("../hooks/useAuth.ts", () => ({
  useAuth: () => ({ user: { email: "reader@example.com" } }),
}));

vi.mock("../hooks/useLocalState.tsx", () => ({
  useLocalState: () => ({ localState: { liveConnection: null } }),
}));

vi.mock("../hooks/useStorageStatus.tsx", () => ({
  StorageProviderIcon: () => null,
  storageProviderLabel: () => "Google Drive",
  useLinkedStorageProvider: () => "GOOGLE_DRIVE",
  useStorageStatus: () => ({
    kind: "connected",
    provider: "GOOGLE_DRIVE",
    canSync: true,
  }),
}));

describe("Tray", () => {
  it("projects the shared image thumbnail into its recent item", () => {
    const markup = renderToStaticMarkup(<Tray />);

    expect(markup).toContain('<img src="blob:tray-preview"');
  });
});
