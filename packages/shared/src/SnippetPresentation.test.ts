import { describe, expect, it } from "vite-plus/test";

import { decodeSnippetText, deriveSnippetPresentation } from "./SnippetPresentation.ts";

const utf8 = (value: string) => new TextEncoder().encode(value);

describe("snippet presentation", () => {
  it("derives general-file and image presentation from the file name", () => {
    expect(deriveSnippetPresentation({ fileName: "report.pdf" })).toEqual({
      type: "file",
      title: "report.pdf",
    });
    expect(deriveSnippetPresentation({ fileName: "photo.WEBP" })).toEqual({
      type: "image",
      title: "photo.WEBP",
    });
  });

  it("derives text presentation and title from UTF-8 content", () => {
    expect(
      deriveSnippetPresentation({
        fileName: "plan.md",
        content: utf8("\n# Ship offline uploads\nMore detail"),
      }),
    ).toEqual({ type: "text", title: "# Ship offline uploads" });
  });

  it("derives hyperlink presentation only from complete text content", () => {
    expect(
      deriveSnippetPresentation({
        fileName: "website.txt",
        content: utf8(" https://example.com/path "),
      }),
    ).toEqual({
      type: "hyperlink",
      title: "https://example.com/path",
      url: "https://example.com/path",
    });
    expect(
      deriveSnippetPresentation({
        fileName: "website.pdf",
        content: utf8("https://example.com/path"),
      }),
    ).toEqual({ type: "file", title: "website.pdf" });
  });

  it("uses a presentation-neutral title when text content is unavailable or invalid", () => {
    expect(deriveSnippetPresentation({ fileName: "note.txt" })).toEqual({
      type: "file",
      title: "Text snippet",
    });
    expect(
      deriveSnippetPresentation({ fileName: "note.txt", content: new Uint8Array([0xff]) }),
    ).toEqual({ type: "file", title: "Text snippet" });
  });

  it("decodes only valid UTF-8 for content-derived presentation", () => {
    expect(decodeSnippetText(utf8("valid text"))).toBe("valid text");
    expect(decodeSnippetText(new Uint8Array([0xc3, 0x28]))).toBeNull();
  });
});
