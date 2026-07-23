import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { decodeStoredSnippetReplica } from "./SnippetReplicaLive.ts";

describe("stored Device Snippet collection", () => {
  it.effect("rejects the superseded authoritative upload-status shape", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeStoredSnippetReplica(
          JSON.stringify({
            items: [
              {
                id: "0d1e2f3a-4567-4890-8abc-def012345678",
                fileName: "legacy.txt",
                byteSize: 12,
                storageProvider: "GOOGLE_DRIVE",
                storageObjectId: "drive-id",
                uploadStatus: "UPLOADED",
                createdAt: "2026-07-10T20:00:00.000Z",
                updatedAt: "2026-07-10T20:00:01.000Z",
              },
            ],
          }),
        ),
      );

      expect(result._tag).toBe("Failure");
    }),
  );
});
