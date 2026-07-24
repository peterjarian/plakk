import { describe, expect, it, vi } from "vite-plus/test";

import { applyAppearanceState } from "./useAppearance.ts";

function makeRoot() {
  const classes = new Set<string>();
  return {
    classes,
    root: {
      classList: {
        toggle: vi.fn((token: string, force?: boolean) => {
          if (force) classes.add(token);
          else classes.delete(token);
          return classes.has(token);
        }),
      },
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" },
    },
  };
}

describe("renderer appearance", () => {
  it("applies the effective appearance to the shared renderer root", () => {
    const { classes, root } = makeRoot();

    applyAppearanceState({ preference: "system", effective: "dark" }, root);
    expect(classes.has("dark")).toBe(true);
    expect(root.dataset).toEqual({
      appearance: "system",
      effectiveAppearance: "dark",
    });
    expect(root.style.colorScheme).toBe("dark");

    applyAppearanceState({ preference: "light", effective: "light" }, root);
    expect(classes.has("dark")).toBe(false);
    expect(root.dataset.appearance).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });
});
