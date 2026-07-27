import type { StorageCleanupRunResult, StorageManagementState } from "@plakk/shared/PlakkApi";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  beginStorageCleanup,
  readStorageManagement,
  reauthorizeStorageProvider,
  retryStorageCleanup,
  type StorageManagementRpcClient,
} from "./storage-management-client.ts";

const management: StorageManagementState = {
  affectedSnippetCount: 3,
  cleanup: null,
  connectionStatus: "CONNECTED",
  externalDestinationUrl: "https://drive.example/folder",
  storageProvider: "GOOGLE_DRIVE",
};

const completed: StorageCleanupRunResult = {
  action: "UNLINK",
  outcome: "COMPLETED",
};

const rpc = (overrides: Partial<StorageManagementRpcClient> = {}): StorageManagementRpcClient => ({
  BeginStorageCleanup: () => Effect.succeed(completed),
  BeginStorageProviderLink: () => Effect.succeed({ url: "https://workos.example/authorize" }),
  GetStorageManagementState: () => Effect.succeed(management),
  RetryStorageCleanup: () => Effect.succeed(completed),
  ...overrides,
});

describe("storage management client", () => {
  it("reads authoritative provider state and exact affected count with a fresh token", async () => {
    const getAccessToken = vi.fn(async () => "fresh-token");
    const read = vi.fn<StorageManagementRpcClient["GetStorageManagementState"]>(() =>
      Effect.succeed(management),
    );

    await expect(
      Effect.runPromise(
        readStorageManagement(rpc({ GetStorageManagementState: read }), getAccessToken),
      ),
    ).resolves.toEqual(management);
    expect(read).toHaveBeenCalledWith(undefined, {
      headers: { authorization: "Bearer fresh-token" },
    });
  });

  it("sends exact DELETE confirmation and keeps retry separate", async () => {
    const begin = vi.fn<StorageManagementRpcClient["BeginStorageCleanup"]>(() =>
      Effect.succeed({ action: "SWITCH", outcome: "COMPLETED" }),
    );
    const retry = vi.fn<StorageManagementRpcClient["RetryStorageCleanup"]>(() =>
      Effect.succeed({ action: "SWITCH", outcome: "COMPLETED" }),
    );
    const client = rpc({ BeginStorageCleanup: begin, RetryStorageCleanup: retry });

    await Effect.runPromise(
      beginStorageCleanup(client, async () => "token", "SWITCH", "GOOGLE_DRIVE", 3),
    );
    expect(begin).toHaveBeenCalledWith(
      {
        action: "SWITCH",
        confirmation: "DELETE",
        expectedSnippetCount: 3,
        storageProvider: "GOOGLE_DRIVE",
      },
      { headers: { authorization: "Bearer token" } },
    );

    await Effect.runPromise(retryStorageCleanup(client, async () => "token", "GOOGLE_DRIVE"));
    expect(retry).toHaveBeenCalledWith(
      { storageProvider: "GOOGLE_DRIVE" },
      { headers: { authorization: "Bearer token" } },
    );
  });

  it("reauthorizes only the same provider through the existing account-bound flow", async () => {
    const begin = vi.fn<StorageManagementRpcClient["BeginStorageProviderLink"]>(() =>
      Effect.succeed({ url: "https://workos.example/authorize" }),
    );

    await expect(
      Effect.runPromise(
        reauthorizeStorageProvider(
          rpc({ BeginStorageProviderLink: begin }),
          async () => "token",
          "DROPBOX",
        ),
      ),
    ).resolves.toEqual({ url: "https://workos.example/authorize" });
    expect(begin).toHaveBeenCalledWith(
      { origin: "WEB", storageProvider: "DROPBOX" },
      { headers: { authorization: "Bearer token" } },
    );
  });
});
