import { describe, expect, it } from "vite-plus/test";

import type { LocalState } from "../../ipc/contracts.ts";
import { storageStatusFromLocalState } from "./useStorageStatus.tsx";

const localState = (input: Partial<LocalState> = {}): LocalState => ({
  revision: 1,
  account: null,
  provider: { known: false, value: null },
  capability: { status: "OFFLINE" },
  liveConnection: null,
  storageUsageBytes: 0,
  snippets: [],
  ...input,
});

describe("storage status from the local state", () => {
  it("keeps cached provider display facts out of offline capability status", () => {
    const status = storageStatusFromLocalState(
      localState({ provider: { known: true, value: "GOOGLE_DRIVE" } }),
    );

    expect(status).toEqual({ kind: "offline", canSync: false });
  });

  it("uses a live connected capability only when main confirms it", () => {
    const status = storageStatusFromLocalState(
      localState({
        provider: { known: true, value: "GOOGLE_DRIVE" },
        capability: {
          status: "ONLINE",
          account: { canSync: true, storageProvider: "GOOGLE_DRIVE", blockedReasons: [] },
          connection: {
            storageProvider: "GOOGLE_DRIVE",
            status: "CONNECTED",
            externalDestinationUrl: "https://drive.example.com/folder",
          },
        },
      }),
    );

    expect(status).toMatchObject({
      kind: "connected",
      canSync: true,
      provider: "GOOGLE_DRIVE",
      destinationUrl: "https://drive.example.com/folder",
    });
  });

  it("keeps a confirmed unlinked account distinct from offline capability", () => {
    const status = storageStatusFromLocalState(
      localState({
        provider: { known: true, value: null },
        capability: {
          status: "ONLINE",
          account: { canSync: false, storageProvider: null, blockedReasons: ["storage"] },
          connection: null,
        },
      }),
    );

    expect(status).toMatchObject({ kind: "unlinked", canSync: false });
  });
});
