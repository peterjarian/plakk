import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import { DesktopSnippetSchema } from "./contracts.ts";

describe("DesktopSnippetSchema", () => {
  it("encodes an uploading local text projection synchronously", () => {
    const encode = Schema.encodeUnknownSync(Schema.Array(DesktopSnippetSchema));

    expect(
      encode([
        {
          id: "0d1e2f3a-4567-4890-8abc-def012345678",
          fileName: "0d1e2f3a-4567-4890-8abc-def012345678.txt",
          byteSize: 4,
          storageProvider: "GOOGLE_DRIVE",
          storageObjectId: null,
          uploadStatus: "UPLOADING",
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          localState: {
            phase: "UPLOADING",
            progress: 0,
            errorMessage: null,
            canRetry: false,
          },
          localTextContent: "text",
          localContentAvailability: { status: "AVAILABLE" },
        },
      ]),
    ).toHaveLength(1);
  });
});
