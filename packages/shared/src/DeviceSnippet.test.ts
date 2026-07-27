import type { ApiSnippet } from "./api/PlakkApi.ts";
import {
  reconcileDeviceSnippetRecords,
  type DeviceSnippetRecord,
  type LocalUploadRecord,
} from "./DeviceSnippet.ts";
import { describe, expect, it } from "vite-plus/test";

const published = (id: string, fileName = `${id}.txt`): ApiSnippet => ({
  id,
  fileName,
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: `object-${id}`,
  createdAt: "2026-07-27T10:00:00.000Z",
  updatedAt: "2026-07-27T10:00:00.000Z",
});

const local = (id: string, status: LocalUploadRecord["status"]): LocalUploadRecord => ({
  kind: "LOCAL",
  id,
  fileName: `${id}.txt`,
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE",
  status,
  errorMessage: status === "FAILED" ? "Upload failed." : null,
  createdAt: "2026-07-27T11:00:00.000Z",
  updatedAt: "2026-07-27T11:00:00.000Z",
});

describe("Device Snippet records", () => {
  it("promotes matching local identity, preserves unmatched local work, and removes stale published records", () => {
    const promotedId = "0d1e2f3a-4567-4890-8abc-def012345678";
    const localId = "1e2f3a4b-5678-4901-8bcd-ef0123456789";
    const staleId = "2f3a4b5c-6789-4012-8cde-f01234567890";
    const current: ReadonlyArray<DeviceSnippetRecord> = [
      local(promotedId, "UPLOADING"),
      local(localId, "FAILED"),
      { kind: "PUBLISHED", snippet: published(staleId) },
    ];

    expect(
      reconcileDeviceSnippetRecords(current, [
        published(promotedId, "published.txt"),
        published("3a4b5c6d-7890-4123-8def-012345678901", "remote.txt"),
      ]),
    ).toEqual([
      local(localId, "FAILED"),
      {
        kind: "PUBLISHED",
        snippet: published(promotedId, "published.txt"),
      },
      {
        kind: "PUBLISHED",
        snippet: published("3a4b5c6d-7890-4123-8def-012345678901", "remote.txt"),
      },
    ]);
  });
});
