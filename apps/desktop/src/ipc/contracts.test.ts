import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import {
  AppearancePreferenceSchema,
  LocalStateSchema,
  StorageFreeUpResultSchema,
  UserConfigPatchSchema,
  UserConfigSchema,
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

describe("UserConfigSchema", () => {
  it("carries the persisted Toolbar widget preference across the desktop boundary", () => {
    const decodeConfig = Schema.decodeUnknownSync(UserConfigSchema);
    const decodePatch = Schema.decodeUnknownSync(UserConfigPatchSchema);

    expect(
      decodeConfig({
        appearance: "system",
        showExternalLinkWarning: true,
        toolbarWidgetEnabled: false,
      }),
    ).toEqual({
      appearance: "system",
      showExternalLinkWarning: true,
      toolbarWidgetEnabled: false,
    });
    expect(decodePatch({ toolbarWidgetEnabled: true })).toEqual({
      toolbarWidgetEnabled: true,
    });
  });
});

describe("LocalStateSchema snippets", () => {
  it("transports the canonical shared snippet directly", () => {
    const encode = Schema.encodeUnknownSync(LocalStateSchema.fields.snippets);

    expect(
      encode([
        {
          id: "0d1e2f3a-4567-4890-8abc-def012345678",
          fileName: "0d1e2f3a-4567-4890-8abc-def012345678.txt",
          title: "text",
          byteSize: 4,
          storageProvider: "GOOGLE_DRIVE",
          mediaType: "text/plain",
          storageObjectId: null,
          status: "UPLOADING",
          errorMessage: null,
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          localContentAvailability: { status: "AVAILABLE" },
        },
      ]),
    ).toHaveLength(1);
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
