import { describe, expect, it } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";
import type { AccountStatus, PipeConnection } from "@plakk/shared/PlakkApi";
import { storageStatusFrom } from "./useStorageStatus.tsx";

const account = (overrides: Partial<AccountStatus> = {}): AccountStatus => ({
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
  blockedReasons: [],
  ...overrides,
});

const connection = (overrides: Partial<PipeConnection> = {}): PipeConnection =>
  ({
    storageProvider: "GOOGLE_DRIVE",
    status: "CONNECTED",
    externalDestinationUrl: "https://drive.google.com/drive/my-drive",
    ...overrides,
  }) as PipeConnection;

describe("storage status", () => {
  it("keeps an unconfigured provider distinct from a connected account", () => {
    const status = storageStatusFrom(
      AsyncResult.success(account({ storageProvider: null })),
      AsyncResult.initial(),
    );

    expect(status).toMatchObject({ kind: "unlinked", canSync: false });
  });

  it("uses the connected provider destination and enables sync", () => {
    const status = storageStatusFrom(
      AsyncResult.success(account()),
      AsyncResult.success(connection()),
    );

    expect(status).toMatchObject({
      kind: "connected",
      canSync: true,
      provider: "GOOGLE_DRIVE",
      destinationUrl: "https://drive.google.com/drive/my-drive",
    });
  });

  it("requires reauthorization without treating storage as unlinked", () => {
    const status = storageStatusFrom(
      AsyncResult.success(account()),
      AsyncResult.success(
        connection({ status: "NEEDS_REAUTHORIZATION", externalDestinationUrl: null }),
      ),
    );

    expect(status).toMatchObject({ kind: "needs-reauthorization", canSync: false });
  });

  it("keeps a connected provider visible while billing blocks sync", () => {
    const status = storageStatusFrom(
      AsyncResult.success(account({ canSync: false, blockedReasons: ["billing"] })),
      AsyncResult.success(connection()),
    );

    expect(status).toMatchObject({ kind: "connected", canSync: false, provider: "GOOGLE_DRIVE" });
  });

  it("does not report a failed connection lookup as unlinked", () => {
    const status = storageStatusFrom(
      AsyncResult.success(account()),
      AsyncResult.fail(new Error("temporary failure")),
    );

    expect(status).toMatchObject({ kind: "failed", canSync: false, provider: "GOOGLE_DRIVE" });
  });
});
