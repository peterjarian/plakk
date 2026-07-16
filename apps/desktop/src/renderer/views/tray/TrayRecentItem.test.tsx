import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { DesktopSnippet } from "../../../ipc/contracts.ts";
import { TrayRecentItem } from "./TrayRecentItem.tsx";

const snippet: DesktopSnippet = {
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
};

const handlers = {
  onCopy: () => undefined,
  onDelete: () => undefined,
  onRetryUpload: () => undefined,
  onStopUpload: () => undefined,
};

describe("TrayRecentItem", () => {
  it("keeps origin upload failures actionable in the widget", () => {
    const markup = renderToStaticMarkup(
      <TrayRecentItem
        snippet={snippet}
        copied={false}
        copying={false}
        copyDisabled={false}
        thumbnailUrl={null}
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
        thumbnailUrl={null}
        {...handlers}
      />,
    );

    expect(markup).toContain('aria-label="Stop uploading"');
  });
});
