import { describe, expect, it } from "vite-plus/test";

import { apiSnippetToSnippet, deleteSnippetPayload } from "./snippets.ts";

describe("snippet atoms", () => {
  it("maps API snippets to display snippets", () => {
    const snippet = apiSnippetToSnippet({
      id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
      kind: "FILE",
      title: "report.pdf",
      fileName: "report.pdf",
      byteSize: 2048,
      contentType: "application/pdf",
      storageProvider: "GOOGLE_DRIVE",
      uploadStatus: "UPLOADING",
      createdAt: "2026-07-08T12:00:00.000Z",
      updatedAt: "2026-07-08T12:00:00.000Z",
    });

    expect(snippet).toMatchObject({
      id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
      kind: "FILE",
      subtitle: "PDF · 2.0 KB",
      synced: false,
      uploadProgress: 0,
    });
  });

  it("keeps delete payloads on the shared RPC id shape", () => {
    expect(deleteSnippetPayload("8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0")).toEqual({
      id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
    });
  });
});
