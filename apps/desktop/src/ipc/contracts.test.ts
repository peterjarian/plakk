import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import { AuthStatusSchema, DesktopSnippetSchema } from "./contracts.ts";

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
          localTextPreview: "text",
          localContentAvailability: { status: "AVAILABLE" },
        },
      ]),
    ).toHaveLength(1);
  });
});

describe("AuthStatusSchema", () => {
  it("does not encode bearer tokens across the renderer boundary", () => {
    const encode = Schema.encodeUnknownSync(AuthStatusSchema);
    expect(encode({ isAuthenticated: false, user: null, accessToken: "secret" })).toEqual({
      isAuthenticated: false,
      user: null,
    });
  });
});
