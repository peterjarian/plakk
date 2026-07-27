import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  BrowserSupportBoundary,
  missingRequiredBrowserCapabilities,
  UnsupportedBrowserView,
} from "./browser-support.tsx";

const supportedBrowser = {
  ReadableStream: class {},
  fetch: () => Promise.resolve(),
};

describe("Web browser support", () => {
  it("does not make local acceleration or clipboard capabilities product requirements", () => {
    expect(missingRequiredBrowserCapabilities(supportedBrowser)).toEqual([]);
  });

  it("reports only capabilities required by the current Web product runtime", () => {
    expect(
      missingRequiredBrowserCapabilities({
        ...supportedBrowser,
        ReadableStream: undefined,
        fetch: undefined,
      }),
    ).toEqual(["fetch", "readable-stream"]);
  });

  it("renders an actionable unsupported state without promising a substitute", () => {
    const markup = renderToStaticMarkup(<UnsupportedBrowserView onRetry={vi.fn()} />);

    expect(markup).toContain("This browser can’t run Plakk");
    expect(markup).toContain("Required Web capabilities");
    expect(markup).toContain(">Check again</button>");
    expect(markup).toContain('href="mailto:help@plakk.io"');
    expect(markup).not.toContain("install");
    expect(markup).not.toContain("Desktop substitute");
  });

  it("blocks product children before they render when a required capability is missing", () => {
    const markup = renderToStaticMarkup(
      <BrowserSupportBoundary capabilities={{ ...supportedBrowser, fetch: undefined }}>
        <p>Protected product child</p>
      </BrowserSupportBoundary>,
    );

    expect(markup).toContain("This browser can’t run Plakk");
    expect(markup).not.toContain("Protected product child");
  });
});
