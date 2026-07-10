import { beforeEach, describe, expect, it } from "vite-plus/test";
import { addClipboardContent, addTextSnippet, setSnippetIngestionEnabled } from "./snippets.ts";

describe("tray snippet ingestion", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
        },
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    setSnippetIngestionEnabled(false);
  });

  it("does not create snippets while blocked and resumes after readiness", () => {
    addTextSnippet("blocked");
    addClipboardContent({ type: "text", text: "blocked paste" });
    expect(values.size).toBe(0);

    setSnippetIngestionEnabled(true);
    addTextSnippet("ready");
    expect([...values.values()].join()).toContain("ready");

    setSnippetIngestionEnabled(false);
    addTextSnippet("blocked again");
    expect([...values.values()].join()).not.toContain("blocked again");
    expect([...values.values()].join()).not.toContain("blocked paste");
  });
});
