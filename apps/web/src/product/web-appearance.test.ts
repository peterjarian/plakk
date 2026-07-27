import { describe, expect, it } from "vite-plus/test";

import {
  applyWebAppearance,
  effectiveWebAppearance,
  readWebAppearancePreference,
  WEB_APPEARANCE_STORAGE_KEY,
} from "./web-appearance.tsx";

describe("Web appearance", () => {
  it("reads only supported persisted preferences", () => {
    expect(
      readWebAppearancePreference({
        getItem: (key) => (key === WEB_APPEARANCE_STORAGE_KEY ? "dark" : null),
      }),
    ).toBe("dark");
    expect(readWebAppearancePreference({ getItem: () => "sepia" })).toBe("system");
    expect(readWebAppearancePreference({ getItem: () => null })).toBe("system");
  });

  it("resolves system preference and applies the effective theme", () => {
    expect(effectiveWebAppearance("system", true)).toBe("dark");
    expect(effectiveWebAppearance("system", false)).toBe("light");
    expect(effectiveWebAppearance("light", true)).toBe("light");

    const tokens = new Set<string>();
    const root = {
      classList: {
        toggle: (token: string, force?: boolean) => {
          if (force) tokens.add(token);
          else tokens.delete(token);
          return force ?? false;
        },
      },
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" },
    };
    applyWebAppearance(root, "dark", "dark");

    expect(tokens.has("dark")).toBe(true);
    expect(root.dataset.appearance).toBe("dark");
    expect(root.dataset.effectiveAppearance).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });
});
