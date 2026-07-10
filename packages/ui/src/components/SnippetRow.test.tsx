import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { formatSnippetDate } from "./SnippetRow.tsx";

const now = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-11T12:00:00.000Z"));
const dateAt = (millisecondsAgo: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now - millisecondsAgo));

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

  it("formats future dates without changing the absolute fallback", () => {
    const tomorrow = DateTime.formatIso(DateTime.makeUnsafe(now + 24 * 60 * 60 * 1000));
    expect(formatSnippetDate(tomorrow, now)).toBe("in a day");
  });
});
