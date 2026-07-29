// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AppHeader } from "./AppHeader.tsx";
import { SnippetList } from "./SnippetList.tsx";
import { SyncStatusIndicator } from "./SyncStatusIndicator.tsx";
import { Settings } from "./settings.tsx";
import { EmptyDescription } from "../primitives/empty.tsx";
import { TooltipProvider } from "../primitives/tooltip.tsx";

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

describe("shared composition", () => {
  it("keeps application-header product copy while accepting host actions", () => {
    const markup = renderToStaticMarkup(
      <AppHeader
        className="host-window-chrome"
        user={{
          id: "user-1",
          email: "person@example.com",
          firstName: "Plakk",
          lastName: "User",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }}
        storageAction={<button type="button">Storage</button>}
        onSettingsClick={() => {}}
        onSignOutClick={() => {}}
      />,
    );

    expect(markup).toContain('data-slot="app-header"');
    expect(markup).toContain("host-window-chrome");
    expect(markup).toContain("Plakk");
    expect(markup).toContain("BETA");
    expect(markup).toContain('aria-label="Account menu"');
    expect(markup).not.toContain("drag-region");
  });

  it("lets each host compose list content while retaining shared semantics", () => {
    const markup = renderToStaticMarkup(
      <SnippetList.Root aria-label="Recent snippets">
        <SnippetList.Heading />
        <SnippetList.Items>
          <li>First snippet</li>
        </SnippetList.Items>
      </SnippetList.Root>,
    );

    expect(markup).toContain('aria-label="Recent snippets"');
    expect(markup).toContain("<h2");
    expect(markup).toContain("Recent");
    expect(markup).toContain("<ul");
    expect(markup).toContain("First snippet");
  });

  it("preserves the list keyboard map without owning row rendering", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);

    act(() => {
      root.render(
        <SnippetList.Items>
          <li>
            <button type="button" data-snippet-row="">
              First
            </button>
          </li>
          <li>
            <button type="button" data-snippet-row="">
              Second
            </button>
          </li>
        </SnippetList.Items>,
      );
    });

    const rows = container.querySelectorAll<HTMLButtonElement>("[data-snippet-row]");
    rows[0]?.focus();
    act(() => {
      rows[0]?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    });

    expect(document.activeElement).toBe(rows[1]);
  });

  it("renders empty-state descriptions with paragraph semantics", () => {
    expect(renderToStaticMarkup(<EmptyDescription>No snippets yet.</EmptyDescription>)).toMatch(
      /^<p /,
    );
  });

  it("standardizes settings composition through named parts", () => {
    const markup = renderToStaticMarkup(
      <Settings.Section>
        <Settings.SectionTitle>Account</Settings.SectionTitle>
        <Settings.SectionBody>
          <Settings.Row>
            <Settings.RowMain>
              <Settings.RowText title="Plakk Pro" description="Current plan" />
            </Settings.RowMain>
            <Settings.RowAction>Manage</Settings.RowAction>
          </Settings.Row>
        </Settings.SectionBody>
      </Settings.Section>,
    );

    expect(markup).toContain('data-slot="settings-section"');
    expect(markup).toContain('data-slot="settings-row"');
    expect(markup).toContain("Plakk Pro");
    expect(markup).toContain("Manage");
  });

  it("presents synchronization as one accessible status dot", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <SyncStatusIndicator status="CONNECTED" />
      </TooltipProvider>,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Up to date"');
    expect(markup).toContain("bg-emerald-500/80");
    expect(markup).not.toContain("Synced");
  });
});
