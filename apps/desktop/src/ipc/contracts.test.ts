import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import {
  AppearancePreferenceSchema,
  DesktopSnippetSchema,
  StorageFreeUpResultSchema,
} from "./contracts.ts";

describe("AppearancePreferenceSchema", () => {
  it("accepts exactly Light, Dark, and System preferences", () => {
    const decode = Schema.decodeUnknownSync(AppearancePreferenceSchema);

    expect(["light", "dark", "system"].map((value) => decode(value))).toEqual([
      "light",
      "dark",
      "system",
    ]);
    expect(() => decode("sepia")).toThrow();
  });
});

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
          kind: "LOCAL",
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          localState: {
            status: "UPLOADING",
            errorMessage: null,
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
      kind: "PUBLISHED",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      localState: null,
      localTextPreview: "text",
      localContentAvailability: { status: "AVAILABLE" },
    });

    expect(snippet).not.toHaveProperty("storageObjectId");
  });
});

describe("StorageFreeUpResultSchema", () => {
  it("accepts an authoritative storage reclamation measurement", () => {
    const decode = Schema.decodeUnknownSync(StorageFreeUpResultSchema);

    expect(decode({ reclaimedBytes: 2048, removedCopies: 1, storageUsageBytes: 4096 })).toEqual({
      reclaimedBytes: 2048,
      removedCopies: 1,
      storageUsageBytes: 4096,
    });
  });
});
