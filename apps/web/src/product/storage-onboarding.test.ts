import type { AccountStatus, StorageProviderStatus } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { storageOnboardingDestination, storageOnboardingOrigin } from "./storage-onboarding.ts";

const account = (input: Partial<AccountStatus> = {}): AccountStatus => ({
  accessEntitlement: {
    status: "TRIAL_ACTIVE",
    trialEndsAt: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
  },
  blockedReasons: ["storage"],
  canSync: false,
  storageProvider: null,
  ...input,
});

const providerStatus = (status: StorageProviderStatus["status"]): StorageProviderStatus =>
  status === "CONNECTED"
    ? {
        storageProvider: "GOOGLE_DRIVE",
        status,
        externalDestinationUrl: "https://drive.example/folder",
      }
    : {
        storageProvider: "GOOGLE_DRIVE",
        status,
        externalDestinationUrl: null,
      };

describe("storage onboarding reconstruction", () => {
  it("returns retry when authoritative provider state is not connected", () => {
    expect(storageOnboardingDestination(account(), providerStatus("NOT_CONNECTED"), "WEB")).toEqual(
      {
        action: "reauthorize",
        kind: "retry",
        provider: "GOOGLE_DRIVE",
      },
    );
  });

  it("rechecks instead of restarting OAuth while account capability catches up", () => {
    expect(
      storageOnboardingDestination(
        account({ storageProvider: "GOOGLE_DRIVE" }),
        providerStatus("CONNECTED"),
        "WEB",
      ),
    ).toEqual({
      action: "recheck",
      kind: "retry",
      provider: "GOOGLE_DRIVE",
    });
  });

  it("continues Web only after the authoritative account and provider agree", () => {
    expect(
      storageOnboardingDestination(
        account({
          blockedReasons: [],
          canSync: true,
          storageProvider: "GOOGLE_DRIVE",
        }),
        providerStatus("CONNECTED"),
        "WEB",
      ),
    ).toEqual({ kind: "continue-web" });
  });

  it("keeps Desktop-origin success presentation separate from entitlement", () => {
    expect(
      storageOnboardingDestination(
        account({
          accessEntitlement: {
            status: "BILLING_RESTRICTED",
          },
          blockedReasons: ["billing"],
          canSync: false,
          storageProvider: "GOOGLE_DRIVE",
        }),
        providerStatus("CONNECTED"),
        "DESKTOP",
      ),
    ).toEqual({ kind: "return-desktop" });
  });

  it("recognizes only the Desktop origin query vocabulary", () => {
    expect(storageOnboardingOrigin("desktop")).toBe("DESKTOP");
    expect(storageOnboardingOrigin("DESKTOP")).toBe("WEB");
  });
});
