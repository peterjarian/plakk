// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    ScriptOnce: ({ children }: { readonly children: React.ReactNode }) => (
      <script>{children}</script>
    ),
  };
});

import { ThemeProvider, useTheme } from "./useTheme.tsx";

const roots: Array<ReturnType<typeof createRoot>> = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const { theme, setTheme } = useTheme();
  return <button onClick={() => setTheme("dark")}>{theme}</button>;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ThemeProvider", () => {
  it("keeps an in-memory theme when local storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is blocked.", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is blocked.", "SecurityError");
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () =>
      root.render(
        <ThemeProvider defaultTheme="light">
          <Harness />
        </ThemeProvider>,
      ),
    );
    expect(container.querySelector("button")?.textContent).toBe("light");

    await act(async () => container.querySelector("button")?.click());
    expect(container.querySelector("button")?.textContent).toBe("dark");
  });
});
