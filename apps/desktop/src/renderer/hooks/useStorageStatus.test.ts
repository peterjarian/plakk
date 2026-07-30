import { describe, expect, it } from "vite-plus/test";

import type { LocalState } from "../../ipc/contracts.ts";
import { storageStatusFromLocalState } from "./useStorageStatus.tsx";

const localState = (input: Partial<LocalState> = {}): LocalState => ({
  revision: 1,
  user: null,
  capability: {
    status: "OFFLINE",
    storageProvider: { known: false, value: null },
  },
  syncStatus: null,
  storageUsageBytes: 0,
  snippets: [],
  ...input,
});

describe("storage status from the local state", () => {
  it("keeps cached provider display facts in the shared offline capability", () => {
    const status = storageStatusFromLocalState(
      localState({
        capability: {
          status: "OFFLINE",
          storageProvider: { known: true, value: "GOOGLE_DRIVE" },
        },
      }),
    );

    expect(status).toEqual({ kind: "offline", canSync: false });
  });

  it("uses a live connected capability only when main confirms it", () => {
    const status = storageStatusFromLocalState(
      localState({
        capability: {
          status: "ONLINE",
          account: {
            canSync: true,
            storageProvider: "GOOGLE_DRIVE",
            blockedReasons: [],
            billing: { status: "SUBSCRIBED", cancelAtPeriodEnd: false },
          },
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
        capability: {
          status: "ONLINE",
          account: {
            canSync: false,
            storageProvider: null,
            blockedReasons: ["billing"],
            billing: { status: "PAYMENT_REQUIRED" },
          },
          connection: null,
        },
      }),
    );

    expect(status).toMatchObject({
      kind: "unlinked",
      canSync: false,
      account: {
        blockedReasons: ["billing"],
        billing: { status: "PAYMENT_REQUIRED" },
      },
    });
  });
});
