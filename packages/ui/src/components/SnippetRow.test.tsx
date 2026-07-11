import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SnippetRow } from "./SnippetRow.tsx";

const snippet = {
  id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
  kind: "TEXT",
  title: "A text snippet",
  fileName: "snippet.txt",
  byteSize: 14,
  contentType: "text/plain",
  storageProvider: null,
  uploadStatus: "READY",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
} as const;

describe("SnippetRow", () => {
  it("does not make ordinary pointer clicks select row content", () => {
    const markup = renderToStaticMarkup(
      <SnippetRow
        snippet={snippet}
        copied={false}
        onCopy={() => undefined}
        onDelete={() => undefined}
        onStopUpload={() => undefined}
        textContent={{ state: "ready", text: "A text snippet" }}
      />,
    );

    expect(markup).toContain('data-snippet-row=""');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("select-none");
  });
});
