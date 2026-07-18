import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import { DesktopSnippetSchema } from "./contracts.ts";

describe("DesktopSnippetSchema", () => {
  it("encodes local state containing an active text upload synchronously", () => {
    const encode = Schema.encodeUnknownSync(Schema.Array(DesktopSnippetSchema));

    expect(
      encode([
        {
          id: "0d1e2f3a-4567-4890-8abc-def012345678",
          fileName: "0d1e2f3a-4567-4890-8abc-def012345678.txt",
          byteSize: 4,
          storageProvider: "GOOGLE_DRIVE",
          uploadStatus: "UPLOADING",
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          localState: {
            phase: "UPLOADING",
            progress: 0,
            errorMessage: null,
            canRetry: false,
          },
          localTextPreview: "text",
          localContentAvailability: { status: "AVAILABLE" },
        },
      ]),
    ).toHaveLength(1);
  });

  it("strips provider object references from renderer display data", () => {
    const decode = Schema.decodeUnknownSync(DesktopSnippetSchema);

    const snippet = decode({
      id: "0d1e2f3a-4567-4890-8abc-def012345678",
      fileName: "note.txt",
      byteSize: 4,
      storageProvider: "GOOGLE_DRIVE",
      storageObjectId: "provider-private-object",
      uploadStatus: "UPLOADED",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      localState: null,
      localTextPreview: "text",
      localContentAvailability: { status: "AVAILABLE" },
    });

    expect(snippet).not.toHaveProperty("storageObjectId");
  });
});
