import type { Rectangle } from "electron";

export function getAnchoredWindowBounds(
  windowSize: { width: number; height: number },
  anchorBounds: Rectangle,
  workArea: Rectangle,
): Rectangle {
  const gap = 8;
  const centeredX = anchorBounds.x + anchorBounds.width / 2 - windowSize.width / 2;
  const x = clamp(centeredX, workArea.x, workArea.x + workArea.width - windowSize.width);
  const opensDown = anchorBounds.y + anchorBounds.height / 2 < workArea.y + workArea.height / 2;
  const y = opensDown
    ? anchorBounds.y + anchorBounds.height + gap
    : anchorBounds.y - windowSize.height - gap;

  return {
    x: Math.round(x),
    y: Math.round(clamp(y, workArea.y, workArea.y + workArea.height - windowSize.height)),
    width: windowSize.width,
    height: windowSize.height,
  };
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
