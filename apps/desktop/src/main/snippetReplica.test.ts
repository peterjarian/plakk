import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { describe, expect, it } from "vite-plus/test";

import { applyPendingReplicaDeletes } from "./snippetReplica.ts";

const deletedId = "0d1e2f3a-4567-4890-8abc-def012345678";
const retainedId = "1d1e2f3a-4567-4890-8abc-def012345679";

const snippet = (id: string): ApiSnippet => ({
  id,
  fileName: `${id}.txt`,
  byteSize: 5,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-file-id",
  uploadStatus: "UPLOADED",
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
});

describe("desktop snippet replica deletion masks", () => {
  it("preserves a newer sync cursor and unrelated items without resurrecting a deletion", () => {
    const interleavedSync = applyPendingReplicaDeletes(
      {
        cursor: "newer-cursor",
        items: [snippet(deletedId), snippet(retainedId)],
      },
      [{ id: deletedId, remoteConfirmed: false, cleanupComplete: true }],
    );

    expect(interleavedSync).toEqual({
      state: {
        cursor: "newer-cursor",
        items: [snippet(retainedId)],
      },
      pendingDeletes: [{ id: deletedId, remoteConfirmed: false, cleanupComplete: true }],
    });

    expect(
      applyPendingReplicaDeletes(
        { cursor: "delete-confirmed", items: [snippet(retainedId)] },
        interleavedSync.pendingDeletes,
      ),
    ).toEqual({
      state: {
        cursor: "delete-confirmed",
        items: [snippet(retainedId)],
      },
      pendingDeletes: [],
    });
  });
});
