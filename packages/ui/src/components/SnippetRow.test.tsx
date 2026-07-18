import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { formatSnippetDate, SnippetRow } from "./SnippetRow.tsx";

const snippet = {
  id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
  fileName: "snippet.txt",
  byteSize: 14,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-object",
  uploadStatus: "UPLOADED",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  localState: null,
  localContentAvailability: { status: "AVAILABLE" } as const,
} as const;

const now = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-11T12:00:00.000Z"));
const dateAt = (millisecondsAgo: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now - millisecondsAgo));

describe("SnippetRow", () => {
  it("does not make ordinary pointer clicks select row content", () => {
    const markup = renderToStaticMarkup(
      <SnippetRow
        snippet={snippet}
        presentation={{ type: "text", title: "A text snippet" }}
        now={now}
        copied={false}
        onCopy={() => undefined}
        onDelete={() => undefined}
        onStopUpload={() => undefined}
      />,
    );

    expect(markup).toContain('data-snippet-row=""');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("select-none");
  });

  it("shows a spinner while copying", () => {
    const markup = renderToStaticMarkup(
      <SnippetRow
        snippet={snippet}
        presentation={{ type: "text", title: "A text snippet" }}
        now={now}
        copied={false}
        copying
        onCopy={() => undefined}
        onDelete={() => undefined}
        onStopUpload={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Copying"');
    expect(markup).toContain("animate-spin");
  });

  it("shows remote uploads as syncing without an origin-only stop action", () => {
    const markup = renderToStaticMarkup(
      <SnippetRow
        snippet={{
          ...snippet,
          uploadStatus: "UPLOADING",
          localContentAvailability: { status: "NOT_AVAILABLE" },
        }}
        presentation={{ type: "text", title: "Text snippet" }}
        now={now}
        copied={false}
        onCopy={() => undefined}
        onDelete={() => undefined}
        onStopUpload={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Syncing"');
    expect(markup).not.toContain('aria-label="Stop uploading"');
  });

  it("shows remote failure without an origin-only retry action", () => {
    for (const uploadStatus of ["FAILED", "CLIENT_UPLOAD_FAILED"] as const) {
      const markup = renderToStaticMarkup(
        <SnippetRow
          snippet={{
            ...snippet,
            uploadStatus,
            localContentAvailability: { status: "NOT_AVAILABLE" },
          }}
          presentation={{ type: "text", title: "Text snippet" }}
          now={now}
          copied={false}
          onCopy={() => undefined}
          onDelete={() => undefined}
          onRetryUpload={() => undefined}
          onStopUpload={() => undefined}
        />,
      );

      expect(markup).toContain("Upload failed on the origin device.");
      expect(markup).not.toContain('aria-label="Retry upload"');
    }
  });

  it("only exposes hyperlink navigation through an explicit surface owner", () => {
    const withoutOwner = renderToStaticMarkup(
      <SnippetRow
        snippet={snippet}
        presentation={{
          type: "hyperlink",
          title: "https://example.com",
          url: "https://example.com",
        }}
        now={now}
        copied={false}
        onCopy={() => undefined}
        onDelete={() => undefined}
        onStopUpload={() => undefined}
      />,
    );
    const withOwner = renderToStaticMarkup(
      <SnippetRow
        snippet={snippet}
        presentation={{
          type: "hyperlink",
          title: "https://example.com",
          url: "https://example.com",
        }}
        now={now}
        copied={false}
        onCopy={() => undefined}
        onDelete={() => undefined}
        onOpenLink={() => undefined}
        onStopUpload={() => undefined}
      />,
    );

    expect(withoutOwner).not.toContain('aria-label="Open link"');
    expect(withOwner).toContain('aria-label="Open link"');
  });

  it("keeps local download failure actionable without deriving a loading title", () => {
    const markup = renderToStaticMarkup(
      <SnippetRow
        snippet={{
          ...snippet,
          localContentAvailability: {
            status: "FAILED",
            message: "Couldn’t download this text. Try again.",
          },
        }}
        presentation={{ type: "text", title: "Text snippet" }}
        now={now}
        copied={false}
        onCopy={() => undefined}
        onDelete={() => undefined}
        onDownload={() => undefined}
        onStopUpload={() => undefined}
      />,
    );

    expect(markup).toContain("Text snippet");
    expect(markup).toContain("Couldn’t download this text. Try again.");
    expect(markup).not.toContain("Loading text");
    expect(markup).toContain('aria-label="Retry download"');
  });

  it("presents automatic and manual hydration as an explicit offline download", () => {
    const markup = renderToStaticMarkup(
      <SnippetRow
        snippet={{
          ...snippet,
          localContentAvailability: { status: "DOWNLOADING" },
        }}
        presentation={{ type: "text", title: "Text snippet" }}
        now={now}
        copied={false}
        onCopy={() => undefined}
        onDelete={() => undefined}
        onStopUpload={() => undefined}
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Downloading for offline access"');
    expect(markup).toContain("Downloading for offline access…");
    expect(markup).toContain("animate-spin");
    expect(markup).not.toContain("Saving on this device");
  });

  it("identifies uploaded managed content as available offline", () => {
    const markup = renderToStaticMarkup(
      <SnippetRow
        snippet={snippet}
        presentation={{ type: "text", title: "A text snippet" }}
        now={now}
        copied={false}
        onCopy={() => undefined}
        onDelete={() => undefined}
        onStopUpload={() => undefined}
      />,
    );

    expect(markup).toContain("Available offline");
  });
});

describe("formatSnippetDate", () => {
  it.each([
    [0, "just now"],
    [59 * 1000, "just now"],
    [60 * 1000, "a minute ago"],
    [60 * 60 * 1000, "an hour ago"],
    [24 * 60 * 60 * 1000, "a day ago"],
    [7 * 24 * 60 * 60 * 1000, "a week ago"],
    [30 * 24 * 60 * 60 * 1000, "a month ago"],
  ])("formats %s milliseconds ago as %s", (millisecondsAgo, expected) => {
    expect(formatSnippetDate(dateAt(millisecondsAgo), now)).toBe(expected);
  });

  it("keeps plural relative units natural", () => {
    expect(formatSnippetDate(dateAt(2 * 24 * 60 * 60 * 1000), now)).toBe("2 days ago");
    expect(formatSnippetDate(dateAt(2 * 7 * 24 * 60 * 60 * 1000), now)).toBe("2 weeks ago");
  });

  it("falls back to the stable absolute date after a year", () => {
    expect(formatSnippetDate(dateAt(12 * 30 * 24 * 60 * 60 * 1000), now)).toBe("12 months ago");
    expect(formatSnippetDate(dateAt(365 * 24 * 60 * 60 * 1000), now)).toBe("2025-07-11");
  });

  it("returns the input prefix for an invalid date", () => {
    expect(formatSnippetDate("not-a-date", now)).toBe("not-a-date");
  });

  it("formats future dates without changing the absolute fallback", () => {
    const tomorrow = DateTime.formatIso(DateTime.makeUnsafe(now + 24 * 60 * 60 * 1000));
    expect(formatSnippetDate(tomorrow, now)).toBe("in a day");
  });
});
