import { describe, expect, it } from "vite-plus/test";

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
});
