import { describe, expect, it } from "vite-plus/test";
import { CreateStoredSnippetPayloadSchema } from "@plakk/shared/PlakkApi";
import * as Schema from "effect/Schema";

import { decodeTextSnippet, encodeTextSnippet } from "./textSnippetContent.ts";

describe("text snippet UTF-8 boundary", () => {
  it("round-trips Unicode, emoji, and multiline content as exact bytes", () => {
    const text = "héllo 👋\n第二行\n";
    const bytes = encodeTextSnippet(text);

    expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(text)));
    expect(decodeTextSnippet(bytes)).toBe(text);
  });

  it("rejects malformed UTF-8 instead of replacing bytes", () => {
    expect(() => decodeTextSnippet(new Uint8Array([0xc3, 0x28]))).toThrow("not valid UTF-8");
  });

  it("rejects empty text metadata at the shared API boundary", async () => {
    await expect(
      Schema.decodeUnknownPromise(CreateStoredSnippetPayloadSchema)({
        id: "0d1e2f3a-4567-4890-8abc-def012345678",
        kind: "TEXT",
        byteSize: 0,
        storageProvider: "GOOGLE_DRIVE",
        storageObjectId: null,
      }),
    ).rejects.toThrow();
    expect(decodeTextSnippet(encodeTextSnippet(""))).toBe("");
  });
});
