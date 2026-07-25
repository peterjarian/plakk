import { describe, expect, it } from "vite-plus/test";
import { getAnchoredWindowBounds } from "./position.ts";
import type { Rectangle } from "electron";

const windowSize = { width: 360, height: 480 };

describe("getAnchoredWindowBounds", () => {
  it("clamps to the left edge when centered placement would overflow", () => {
    expect(
      getAnchoredWindowBounds(
        windowSize,
        { x: -20, y: 20, width: 20, height: 20 },
        { x: 0, y: 0, width: 1440, height: 900 },
      ),
    ).toEqual({ x: 0, y: 48, width: 360, height: 480 } satisfies Rectangle);
  });

  it("opens above the tray and clamps to the right edge near the bottom corner", () => {
    expect(
      getAnchoredWindowBounds(
        windowSize,
        { x: 1380, y: 860, width: 40, height: 20 },
        { x: 0, y: 0, width: 1440, height: 900 },
      ),
    ).toEqual({ x: 1080, y: 372, width: 360, height: 480 } satisfies Rectangle);
  });

  it("uses the work-area origin when the window is larger than the work area", () => {
    expect(
      getAnchoredWindowBounds(
        windowSize,
        { x: 220, y: 80, width: 20, height: 20 },
        { x: 100, y: 50, width: 300, height: 200 },
      ),
    ).toEqual({ x: 100, y: 50, width: 360, height: 480 } satisfies Rectangle);
  });
});
