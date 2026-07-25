import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { describe, expect, it } from "vite-plus/test";

import type { SnippetReplicaState } from "./SnippetReplica.ts";
import { reconcileSnippetSnapshot } from "./sync.ts";

const published: ApiSnippet = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "published.txt",
  byteSize: 12,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-id",
  createdAt: "2026-07-10T20:00:00.000Z",
  updatedAt: "2026-07-10T20:00:01.000Z",
};

const local = {
  kind: "LOCAL" as const,
  id: "1e2f3a4b-5678-4901-8bcd-ef0123456789",
  fileName: "local.txt",
  byteSize: 8,
  storageProvider: "GOOGLE_DRIVE" as const,
  status: "FAILED" as const,
  errorMessage: "This upload was interrupted.",
  createdAt: "2026-07-10T21:00:00.000Z",
  updatedAt: "2026-07-10T21:00:01.000Z",
};

describe("Device Snippet record reconciliation", () => {
  it("preserves unmatched local records and promotes a matching local UUID", () => {
    const current: SnippetReplicaState = {
      items: [{ kind: "PUBLISHED", snippet: published }, local],
    };
    const replacement = { ...published, fileName: "replacement.txt" };

    expect(reconcileSnippetSnapshot(current, [replacement])).toEqual({
      state: {
        items: [local, { kind: "PUBLISHED", snippet: replacement }],
      },
      stalePublishedIds: [],
    });
    expect(reconcileSnippetSnapshot({ items: [local] }, [{ ...published, id: local.id }])).toEqual({
      state: { items: [{ kind: "PUBLISHED", snippet: { ...published, id: local.id } }] },
      stalePublishedIds: [],
    });
  });
});
