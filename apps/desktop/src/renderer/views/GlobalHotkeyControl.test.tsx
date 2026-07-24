import { formatForDisplay } from "@tanstack/react-hotkeys";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { GlobalHotkeyControl, normalizeRecordedHotkey } from "./Settings.tsx";

const status = {
  enabled: true,
  shortcut: "Mod+Shift+ArrowUp",
  errorMessage: null,
} as const;

describe("GlobalHotkeyControl", () => {
  it("bridges shifted punctuation emitted by the recorder to portable base keys", () => {
    expect(normalizeRecordedHotkey("Mod+Shift++")).toBe("Mod+Shift+=");
    expect(normalizeRecordedHotkey("Mod+Shift+?")).toBe("Mod+Shift+/");
    expect(normalizeRecordedHotkey("Mod+Shift+ArrowUp")).toBe("Mod+Shift+ArrowUp");
  });

  it("displays the saved portable shortcut with platform-appropriate formatting", () => {
    const markup = renderToStaticMarkup(
      <GlobalHotkeyControl
        busy={false}
        error={null}
        isRecording={false}
        onBeginRecording={vi.fn()}
        onCancelRecording={vi.fn()}
        onUpdate={vi.fn()}
        status={status}
      />,
    );

    expect(markup).toContain("Ctrl+Shift+↑");
    expect(formatForDisplay(status.shortcut, { platform: "mac" })).toBe("⌘ ⇧ ↑");
    expect(formatForDisplay("Mod+Alt+Space", { platform: "windows" })).toBe("Ctrl+Alt+␣");
  });

  it("clearly exposes listening, cancellation, and registration errors", () => {
    const markup = renderToStaticMarkup(
      <GlobalHotkeyControl
        busy={false}
        error="That shortcut is unavailable."
        isRecording
        onBeginRecording={vi.fn()}
        onCancelRecording={vi.fn()}
        onUpdate={vi.fn()}
        status={status}
      />,
    );

    expect(markup).toContain("Press shortcut…");
    expect(markup).toContain(">Cancel<");
    expect(markup).toContain("Listening… Press a shortcut, or press Escape to cancel.");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("That shortcut is unavailable.");
  });
});
