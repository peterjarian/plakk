import { describe, expect, it } from "vite-plus/test";
import type { AccountStatus } from "@plakk/shared/PlakkApi";
import { trayBlockers } from "./TrayBlocked.tsx";

const account = (
  blockedReasons: AccountStatus["blockedReasons"],
  storageProvider: AccountStatus["storageProvider"] = "GOOGLE_DRIVE",
): AccountStatus => ({
  canSync: false,
  blockedReasons,
  storageProvider,
});

describe("tray blocking states", () => {
  it("represents billing, storage, and combined requirements", () => {
    expect(
      trayBlockers({
        kind: "resolved",
        account: account(["billing"]),
      }),
    ).toEqual(["billing"]);
    expect(
      trayBlockers({
        kind: "resolved",
        account: account(["storage"], null),
      }),
    ).toEqual(["storage"]);
    expect(
      trayBlockers({
        kind: "resolved",
        account: account(["billing", "storage"], null),
      }),
    ).toEqual(["billing", "storage"]);
  });

  it("fails closed while status is loading or failed", () => {
    const loading = { kind: "loading" } as const;
    const failed = { kind: "failed" } as const;
    expect(trayBlockers(loading)).toEqual(["loading"]);
    expect(trayBlockers(failed)).toEqual(["failed"]);
  });
});
