import type { DrizzleService } from "@plakk/db";
import type { SnippetRow } from "@plakk/db/schema";
import { describe, expect, it } from "vite-plus/test";
import { DateTime, Effect } from "effect";

import { getSnippetSnapshot } from "./snippetSnapshots.ts";

const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-20T12:00:00Z"));
const snippet: SnippetRow = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  ownerWorkosUserId: "account-1",
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "provider-object",
  uploadStatus: "UPLOADED",
  uploadHeartbeatExpiresAt: null,
  fileName: "complete.txt",
  byteSize: 12,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("complete Snippet snapshots", () => {
  it("returns the complete ordered query result directly", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ pipe: () => Effect.succeed([snippet]) }),
          }),
        }),
      }),
    } as unknown as DrizzleService["db"];

    const result = await Effect.runPromise(getSnippetSnapshot({ db }, "account-1"));

    expect(result).toEqual([
      expect.objectContaining({
        id: snippet.id,
        storageObjectId: "provider-object",
        uploadStatus: "UPLOADED",
      }),
    ]);
  });
});
