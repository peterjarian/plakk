import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { Home } from "./Home.tsx";
import { Tray } from "./Tray.tsx";

const state = vi.hoisted(() => {
  const account = {
    id: "user_1",
    email: "reader@example.com",
    firstName: "Offline",
    lastName: "Reader",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;
  const projection = {
    revision: 7,
    account,
    provider: { known: true, value: "GOOGLE_DRIVE" },
    capability: { status: "OFFLINE" },
    snippets: [
      {
        id: "0d1e2f3a-4567-4890-8abc-def012345678",
        fileName: "same-projection.txt",
        byteSize: 4,
        storageProvider: "GOOGLE_DRIVE",
        uploadStatus: "UPLOADED",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        localState: null,
        localTextPreview: "same",
        localContentAvailability: { status: "AVAILABLE" },
      },
    ],
  } as const;
  return { account, projection };
});

vi.mock("../hooks/useDesktopProjection.tsx", () => ({
  useDesktopProjection: () => ({
    projection: state.projection,
    isLoading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock("../hooks/useAuth.ts", () => ({
  signOut: vi.fn(),
  useAuth: () => ({ issue: null, isLoading: false, user: state.account }),
}));

describe("desktop projection views", () => {
  it("presents the same cached offline projection in Home and Tray", () => {
    const home = renderToStaticMarkup(<Home />);
    const tray = renderToStaticMarkup(<Tray />);

    expect(home).toContain(">same<");
    expect(tray).toContain(">same<");
    expect(home).toContain("Offline — cached snippets stay available.");
    expect(tray).toContain("Offline — cached snippets stay available");
  });
});
