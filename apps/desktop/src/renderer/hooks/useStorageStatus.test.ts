import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import type { LocalState } from "../../ipc/contracts.ts";
import { storageStatusFromLocalState, storageSetupUrl } from "./useStorageStatus.tsx";

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
  it("marks storage setup as a Desktop-originated Web journey", () => {
    expect(storageSetupUrl).toBe("https://app.plakk.io/storage?origin=desktop");
  });

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
          account: {
            accessEntitlement: {
              status: "TRIAL_ACTIVE",
              trialEndsAt: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
            },
            canSync: true,
            storageProvider: "GOOGLE_DRIVE",
            blockedReasons: [],
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

  it("consumes the shared billing-restricted capability without a Desktop trial lifecycle", () => {
    const status = storageStatusFromLocalState(
      localState({
        provider: { known: true, value: "GOOGLE_DRIVE" },
        capability: {
          status: "ONLINE",
          account: {
            accessEntitlement: {
              status: "BILLING_RESTRICTED",
            },
            canSync: false,
            storageProvider: "GOOGLE_DRIVE",
            blockedReasons: ["billing"],
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
      canSync: false,
      account: {
        accessEntitlement: {
          status: "BILLING_RESTRICTED",
        },
        blockedReasons: ["billing"],
      },
    });
  });

  it("keeps a confirmed unlinked account distinct from offline capability", () => {
    const status = storageStatusFromLocalState(
      localState({
        provider: { known: true, value: null },
        capability: {
          status: "ONLINE",
          account: {
            accessEntitlement: {
              status: "TRIAL_ACTIVE",
              trialEndsAt: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
            },
            canSync: false,
            storageProvider: null,
            blockedReasons: ["storage"],
          },
          connection: null,
        },
      }),
    );

    expect(status).toMatchObject({ kind: "unlinked", canSync: false });
  });
});
