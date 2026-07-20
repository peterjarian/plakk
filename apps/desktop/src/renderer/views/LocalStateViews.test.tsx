import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { Home } from "./Home.tsx";
import { Tray } from "./Tray.tsx";

const state = vi.hoisted(() => {
  let liveConnection: { readonly status: "CONNECTED" | "RECONNECTING" } | null = null;
  const account = {
    id: "user_1",
    email: "reader@example.com",
    firstName: "Offline",
    lastName: "Reader",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;
  const localState = {
    revision: 7,
    account,
    provider: { known: true, value: "GOOGLE_DRIVE" },
    capability: { status: "OFFLINE" },
    get liveConnection() {
      return liveConnection;
    },
    snippets: [
      {
        id: "0d1e2f3a-4567-4890-8abc-def012345678",
        fileName: "same-local-state.txt",
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
  return {
    account,
    localState,
    setLiveConnection: (next: typeof liveConnection) => {
      liveConnection = next;
    },
  };
});

vi.mock("../hooks/useLocalState.tsx", () => ({
  useLocalState: () => ({
    localState: state.localState,
    isLoading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock("../hooks/useAuth.ts", () => ({
  signOut: vi.fn(),
  useAuth: () => ({ issue: null, isLoading: false, user: state.account }),
}));

describe("local state views", () => {
  it("presents the same cached offline local state in Home and Tray", () => {
    const home = renderToStaticMarkup(<Home />);
    const tray = renderToStaticMarkup(<Tray />);

    expect(home).toContain(">same<");
    expect(tray).toContain(">same<");
    expect(home).toContain(">OR<");
    expect(tray).toContain("reader@example.com");
    expect(home).toContain("Google Drive");
    expect(tray).toContain("Google Drive");
    expect(home).toContain("Offline — cached snippets stay available.");
    expect(tray).toContain("Offline — cached snippets stay available");
  });

  it("presents reconnecting live updates in Home and Tray", () => {
    state.setLiveConnection({ status: "RECONNECTING" });

    const home = renderToStaticMarkup(<Home />);
    const tray = renderToStaticMarkup(<Tray />);

    expect(home).toContain("Live updates reconnecting…");
    expect(tray).toContain("Reconnecting…");
    state.setLiveConnection(null);
  });
});
