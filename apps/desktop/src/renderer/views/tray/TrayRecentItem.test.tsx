import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { SnippetReadModel } from "../../hooks/useSnippets.ts";
import { TrayRecentItem } from "./TrayRecentItem.tsx";

const snippet: SnippetReadModel = {
  id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
  fileName: "snippet.txt",
  byteSize: 14,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: null,
  uploadStatus: "FAILED",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  localState: {
    phase: "FAILED",
    progress: 48,
    errorMessage: "The storage upload did not complete.",
    canRetry: true,
  },
  localTextContent: "A text snippet",
  contentAvailable: true,
  presentation: { type: "text", title: "A text snippet" },
  textContent: { state: "ready", text: "A text snippet" },
  thumbnailUrl: null,
};

const handlers = {
  onCopy: () => undefined,
  onDelete: () => undefined,
  onReload: () => undefined,
  onRetryUpload: () => undefined,
  onStopUpload: () => undefined,
};

describe("TrayRecentItem", () => {
  it("shows a controlled retry instead of an empty state when snippet loading fails", () => {
    const markup = renderToStaticMarkup(
      <TrayRecentItem
        snippet={undefined}
        copied={false}
        copying={false}
        copyDisabled
        readError="Couldn’t load snippets. Try again."
        {...handlers}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Couldn’t load snippets. Try again.");
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("Nothing added yet");
  });

  it("keeps origin upload failures actionable in the widget", () => {
    const markup = renderToStaticMarkup(
      <TrayRecentItem
        snippet={snippet}
        copied={false}
        copying={false}
        copyDisabled={false}
        readError={null}
        {...handlers}
      />,
    );

    expect(markup).toContain('aria-label="Retry upload"');
    expect(markup).toContain('aria-label="Delete"');
  });

  it("lets the origin stop active upload work from the widget", () => {
    const markup = renderToStaticMarkup(
      <TrayRecentItem
        snippet={{
          ...snippet,
          uploadStatus: "UPLOADING",
          localState: { ...snippet.localState!, phase: "UPLOADING", canRetry: false },
        }}
        copied={false}
        copying={false}
        copyDisabled={false}
        readError={null}
        {...handlers}
      />,
    );

    expect(markup).toContain('aria-label="Stop uploading"');
  });
});
