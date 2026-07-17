import { describe, expect, it } from "vite-plus/test";

import { encodeTextSnippet } from "./textSnippetContent.ts";

describe("text snippet UTF-8 boundary", () => {
  it("round-trips Unicode, emoji, and multiline content as exact bytes", () => {
    const text = "héllo 👋\n第二行\n";
    const bytes = encodeTextSnippet(text);

    expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(text)));
    expect(new TextDecoder().decode(bytes)).toBe(text);
  });
});
