import type { AccountStatus, StorageProviderStatus } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  beginStorageProviderLink,
  readStorageOnboarding,
  type StorageOnboardingRpcClient,
} from "./storage-onboarding-client.ts";

const unlinkedAccount: AccountStatus = {
  accessEntitlement: {
    status: "TRIAL_ACTIVE",
    trialEndsAt: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
  },
  blockedReasons: ["storage"],
  canSync: false,
  storageProvider: null,
};

const connectedAccount: AccountStatus = {
  ...unlinkedAccount,
  blockedReasons: [],
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
};

const connectedProvider: StorageProviderStatus = {
  storageProvider: "GOOGLE_DRIVE",
  status: "CONNECTED",
  externalDestinationUrl: "https://drive.example/folder",
};

const rpc = (overrides: Partial<StorageOnboardingRpcClient> = {}): StorageOnboardingRpcClient => ({
  BeginStorageProviderLink: () =>
    Effect.succeed({ url: "https://api.workos.com/provider-redirect" }),
  GetAccountStatus: () => Effect.succeed(unlinkedAccount),
  GetStorageProviderStatus: () =>
    Effect.succeed({
      storageProvider: "GOOGLE_DRIVE",
      status: "NOT_CONNECTED",
      externalDestinationUrl: null,
    }),
  ...overrides,
});

describe("storage onboarding client", () => {
  it("uses a fresh WorkOS bearer token and exposes no provider credential", async () => {
    const begin = vi.fn<StorageOnboardingRpcClient["BeginStorageProviderLink"]>(() =>
      Effect.succeed({ url: "https://api.workos.com/provider-redirect" }),
    );

    await expect(
      Effect.runPromise(
        beginStorageProviderLink(
          rpc({ BeginStorageProviderLink: begin }),
          () => Promise.resolve("fresh-workos-token"),
          "DROPBOX",
          "DESKTOP",
        ),
      ),
    ).resolves.toEqual({ url: "https://api.workos.com/provider-redirect" });

    expect(begin).toHaveBeenCalledWith(
      { storageProvider: "DROPBOX", origin: "DESKTOP" },
      { headers: { authorization: "Bearer fresh-workos-token" } },
    );
  });

  it("rereads account capability after authoritative provider connection", async () => {
    const getAccount = vi
      .fn<StorageOnboardingRpcClient["GetAccountStatus"]>()
      .mockReturnValueOnce(Effect.succeed(unlinkedAccount))
      .mockReturnValueOnce(Effect.succeed(connectedAccount));

    await expect(
      Effect.runPromise(
        readStorageOnboarding(
          rpc({
            GetAccountStatus: getAccount,
            GetStorageProviderStatus: () => Effect.succeed(connectedProvider),
          }),
          () => Promise.resolve("fresh-workos-token"),
          "GOOGLE_DRIVE",
        ),
      ),
    ).resolves.toEqual({
      account: connectedAccount,
      providerStatus: connectedProvider,
    });
    expect(getAccount).toHaveBeenCalledTimes(2);
  });

  it("does not reread or claim success when provider status is not connected", async () => {
    const getAccount = vi.fn(() => Effect.succeed(unlinkedAccount));

    const result = await Effect.runPromise(
      readStorageOnboarding(
        rpc({ GetAccountStatus: getAccount }),
        () => Promise.resolve("fresh-workos-token"),
        "GOOGLE_DRIVE",
      ),
    );

    expect(result.account).toEqual(unlinkedAccount);
    expect(result.providerStatus?.status).toBe("NOT_CONNECTED");
    expect(getAccount).toHaveBeenCalledOnce();
  });
});
