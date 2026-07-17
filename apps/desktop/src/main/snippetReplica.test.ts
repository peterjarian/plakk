import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { ManagedSnippetContent, SnippetReplica } from "@plakk/shared/SnippetReplica";
import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Stream } from "effect";

import { applyPendingReplicaDeletes, getManagedSnippetBytes } from "./snippetReplica.ts";

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

describe("desktop managed snippet actions", () => {
  it("rejects same-size content when its integrity check fails", async () => {
    let invalidated = false;
    let read = false;
    const content = ManagedSnippetContent.of({
      available: () => Effect.succeed(false),
      get: () =>
        Effect.sync(() => {
          read = true;
          return new Uint8Array(5);
        }),
      invalidate: () =>
        Effect.sync(() => {
          invalidated = true;
        }),
      putStream: () => Effect.void,
    });
    const replica = SnippetReplica.of({
      changes: Stream.empty,
      commit: () => Effect.void,
      completeDeleteCleanup: () => Effect.void,
      get: () => Effect.succeed(null),
      pendingDeleteIds: () => Effect.succeed([]),
      remove: () => Effect.void,
    });

    await expect(
      Effect.runPromise(
        getManagedSnippetBytes({ id: "user-1" }, deletedId, snippet(deletedId)).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(ManagedSnippetContent, content),
              Layer.succeed(SnippetReplica, replica),
            ),
          ),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "SnippetReplicaError",
      reason: "Download this snippet before using it on this device.",
    });
    expect(invalidated).toBe(true);
    expect(read).toBe(false);
  });
});
