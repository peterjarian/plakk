import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { SnippetReadModel } from "../../hooks/useSnippets.ts";
import { TrayRecentItem } from "./TrayRecentItem.tsx";

const snippet: SnippetReadModel = {
  id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
  fileName: "snippet.txt",
  byteSize: 14,
  storageProvider: "GOOGLE_DRIVE",
  kind: "LOCAL",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  localState: {
    status: "FAILED",
    errorMessage: "The storage upload did not complete.",
  },
  localTextPreview: "A text snippet",
  localContentAvailability: { status: "AVAILABLE" },
  presentation: { type: "text", title: "A text snippet" },
  thumbnailUrl: null,
};

const handlers = {
  onCopy: () => undefined,
  onDelete: () => undefined,
  onDownload: () => undefined,
  onOpenLink: () => undefined,
  onReload: () => undefined,
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

  it("keeps origin upload failures dismissible in the widget", () => {
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

    expect(markup).not.toContain('aria-label="Retry upload"');
    expect(markup).toContain('aria-label="Dismiss failed upload"');
  });

  it("shows active upload work without stop or retry controls", () => {
    const markup = renderToStaticMarkup(
      <TrayRecentItem
        snippet={{
          ...snippet,
          localState: { status: "UPLOADING", errorMessage: null },
        }}
        copied={false}
        copying={false}
        copyDisabled={false}
        readError={null}
        {...handlers}
      />,
    );

    expect(markup).toContain('aria-label="Syncing"');
    expect(markup).not.toContain('aria-label="Stop uploading"');
    expect(markup).not.toContain('aria-label="Retry upload"');
  });

  it("offers the same local download action as the main snippet row", () => {
    const markup = renderToStaticMarkup(
      <TrayRecentItem
        snippet={{
          ...snippet,
          kind: "PUBLISHED",
          localState: null,
          localTextPreview: null,
          localContentAvailability: { status: "NOT_AVAILABLE" },
          presentation: { type: "text", title: "Text snippet" },
        }}
        copied={false}
        copying={false}
        copyDisabled
        readError={null}
        {...handlers}
      />,
    );

    expect(markup).toContain('aria-label="Download to this device"');
    expect(markup).not.toContain(snippet.id);
    expect(markup).not.toContain("Loading text");
  });

  it("shows download progress without replacing snippet metadata", () => {
    const markup = renderToStaticMarkup(
      <TrayRecentItem
        snippet={{
          ...snippet,
          kind: "PUBLISHED",
          localState: null,
          localTextPreview: null,
          localContentAvailability: { status: "DOWNLOADING" },
          presentation: { type: "text", title: "Text snippet" },
        }}
        copied={false}
        copying={false}
        copyDisabled
        readError={null}
        {...handlers}
      />,
    );

    expect(markup).toContain('aria-label="Downloading for offline access"');
    expect(markup).toContain("14 B · a week ago");
    expect(markup).not.toContain("Downloading for offline access…");
  });

  it("offers the same hydrated hyperlink action as the main snippet row", () => {
    const markup = renderToStaticMarkup(
      <TrayRecentItem
        snippet={{
          ...snippet,
          kind: "PUBLISHED",
          localState: null,
          localTextPreview: "https://plakk.app/notes",
          presentation: {
            type: "hyperlink",
            title: "plakk.app/notes",
            url: "https://plakk.app/notes",
          },
        }}
        copied={false}
        copying={false}
        copyDisabled={false}
        readError={null}
        {...handlers}
      />,
    );

    expect(markup).toContain('aria-label="Open link"');
  });
});
