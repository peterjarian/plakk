import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { LocalState } from "../../ipc/contracts.ts";
import { Home, STORAGE_WARNING_BYTES } from "./Home.tsx";
import { Settings } from "./Settings.tsx";
import { Tray } from "./Tray.tsx";

const state = vi.hoisted(() => {
  let syncStatus: "CONNECTED" | "RECONNECTING" | null = null;
  let storageUsageBytes = 0;
  let capability: LocalState["capability"] = {
    status: "OFFLINE",
    storageProvider: { known: true, value: "GOOGLE_DRIVE" },
  };
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
    user: account,
    get capability() {
      return capability;
    },
    get syncStatus() {
      return syncStatus;
    },
    get storageUsageBytes() {
      return storageUsageBytes;
    },
    snippets: [
      {
        id: "0d1e2f3a-4567-4890-8abc-def012345678",
        fileName: "same-local-state.txt",
        title: "same",
        byteSize: 4,
        storageProvider: "GOOGLE_DRIVE",
        mediaType: "text/plain",
        storageObjectId: "object-1",
        status: "PUBLISHED",
        errorMessage: null,
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        localContentAvailability: { status: "AVAILABLE" },
      },
    ],
  } as const;
  return {
    account,
    localState,
    setSyncStatus: (next: typeof syncStatus) => {
      syncStatus = next;
    },
    setCapability: (next: LocalState["capability"]) => {
      capability = next;
    },
    setStorageUsageBytes: (next: number) => {
      storageUsageBytes = next;
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
    expect(home).toContain('aria-label="Offline"');
    expect(tray).toContain('aria-label="Offline"');
    expect(home).not.toContain("Offline — cached snippets stay available.");
    expect(tray).not.toContain("Offline — cached snippets stay available");
  });

  it("presents live state compactly without visible connection copy", () => {
    state.setCapability({
      status: "ONLINE",
      account: {
        canSync: true,
        storageProvider: "GOOGLE_DRIVE",
        blockedReasons: [],
      },
      connection: {
        storageProvider: "GOOGLE_DRIVE",
        status: "CONNECTED",
        externalDestinationUrl: "https://drive.google.com/drive/folders/plakk",
      },
    });
    state.setSyncStatus("RECONNECTING");

    const reconnectingHome = renderToStaticMarkup(<Home />);
    const reconnectingTray = renderToStaticMarkup(<Tray />);

    expect(reconnectingHome).toContain('aria-label="Reconnecting"');
    expect(reconnectingTray).toContain('aria-label="Reconnecting"');
    expect(reconnectingHome).not.toContain(">Live updates reconnecting…<");
    expect(reconnectingTray).not.toContain(">Reconnecting…<");

    state.setSyncStatus("CONNECTED");
    const connectedHome = renderToStaticMarkup(<Home />);
    const connectedTray = renderToStaticMarkup(<Tray />);

    expect(connectedHome).toContain('aria-label="Up to date"');
    expect(connectedTray).toContain('aria-label="Up to date"');
    expect(connectedHome).not.toContain(">Live updates connected<");
    expect(connectedTray).not.toContain(">Live<");

    state.setSyncStatus(null);
    state.setCapability({
      status: "OFFLINE",
      storageProvider: { known: true, value: "GOOGLE_DRIVE" },
    });
  });

  it("warns above 30 GiB and links Home to the Settings storage controls", () => {
    state.setStorageUsageBytes(STORAGE_WARNING_BYTES);
    expect(renderToStaticMarkup(<Home />)).not.toContain("Manage storage");

    state.setStorageUsageBytes(STORAGE_WARNING_BYTES + 1024 ** 3);
    const home = renderToStaticMarkup(<Home />);
    const settings = renderToStaticMarkup(<Settings />);

    expect(home).toContain("Plakk is using over 30 GB on this device.");
    expect(home).toContain("Manage storage");
    expect(settings).toContain("31.0 GB used by Plakk");
    expect(settings).toContain("Free up space");
    state.setStorageUsageBytes(0);
  });

  it("shows the current appearance choice in Settings", () => {
    const settings = renderToStaticMarkup(<Settings />);

    expect(settings).toContain('aria-label="Appearance"');
    expect(settings).toContain(">System</span>");
    expect(settings).toContain('value="system"');
  });
});
