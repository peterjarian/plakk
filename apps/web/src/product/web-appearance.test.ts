// @vitest-environment happy-dom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  applyWebAppearance,
  effectiveWebAppearance,
  readWebAppearancePreference,
  useWebAppearance,
  WEB_APPEARANCE_STORAGE_KEY,
  WEB_APPEARANCE_BOOTSTRAP_SCRIPT,
  WebAppearanceProvider,
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

  it("bootstraps a persisted theme before hydration", () => {
    const originalMatchMedia = window.matchMedia;
    window.localStorage.setItem(WEB_APPEARANCE_STORAGE_KEY, "dark");
    window.matchMedia = () => ({ matches: false }) as MediaQueryList;

    window.eval(WEB_APPEARANCE_BOOTSTRAP_SCRIPT);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.appearance).toBe("dark");
    expect(document.documentElement.dataset.effectiveAppearance).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    window.localStorage.clear();
    window.matchMedia = originalMatchMedia;
  });

  it("keeps the server and first browser render deterministic before persisted state hydrates", () => {
    window.localStorage.setItem(WEB_APPEARANCE_STORAGE_KEY, "dark");

    const AppearanceProbe = () => createElement("span", null, useWebAppearance().preference);
    const html = renderToStaticMarkup(
      createElement(WebAppearanceProvider, null, createElement(AppearanceProbe)),
    );

    expect(html).toContain(">system<");
    expect(html).not.toContain(">dark<");
    window.localStorage.clear();
  });
});
