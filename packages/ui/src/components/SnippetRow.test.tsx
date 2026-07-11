import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { formatSnippetDate, SnippetRow } from "./SnippetRow.tsx";

const snippet = {
  id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
  kind: "TEXT",
  title: "A text snippet",
  fileName: "snippet.txt",
  byteSize: 14,
  contentType: "text/plain",
  contentUrl: null,
  thumbnailUrl: null,
  textContent: null,
  storageProvider: null,
  uploadStatus: "READY",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
} as const;

const now = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-11T12:00:00.000Z"));
const dateAt = (millisecondsAgo: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now - millisecondsAgo));

describe("SnippetRow", () => {
  it("does not make ordinary pointer clicks select row content", () => {
    const markup = renderToStaticMarkup(
      <SnippetRow
        snippet={snippet}
        now={now}
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

  it("shows a spinner while copying", () => {
    const markup = renderToStaticMarkup(
      <SnippetRow
        snippet={snippet}
        now={now}
        copied={false}
        copying
        onCopy={() => undefined}
        onDelete={() => undefined}
        onStopUpload={() => undefined}
        textContent={{ state: "ready", text: "A text snippet" }}
      />,
    );

    expect(markup).toContain('aria-label="Copying"');
    expect(markup).toContain("animate-spin");
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
