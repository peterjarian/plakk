// @vitest-environment happy-dom

import type { User } from "@plakk/shared";
import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { HomeView } from "./HomeView.tsx";
import { WebSnippetActionError } from "./snippet-actions.ts";
import type { WebProductContextValue } from "./web-product-context.tsx";

const user: User = {
  id: "user_1",
  email: "reader@example.com",
  firstName: "Web",
  lastName: "Reader",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const account: AccountStatus = {
  accessEntitlement: {
    status: "TRIAL_ACTIVE",
    trialEndsAt: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
  },
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
  blockedReasons: [],
};

const readyState: Parameters<typeof HomeView>[0]["state"] = {
  account,
  accountId: user.id,
  apiAvailability: "available",
  kind: "ready",
  liveConnection: "connected",
  localReadPerformance: "accelerated",
  snippets: [],
};

const textSnippet: ApiSnippet = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "note.txt",
  byteSize: 5,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-object",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const actions = (
  overrides: Partial<NonNullable<WebProductContextValue["snippetActions"]>> = {},
): NonNullable<WebProductContextValue["snippetActions"]> => ({
  copy: vi.fn().mockResolvedValue({ kind: "COPIED" as const }),
  delete: vi.fn().mockResolvedValue(undefined),
  download: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(undefined),
  prepareOpen: vi.fn().mockResolvedValue({ url: "https://example.com/path" }),
  ...overrides,
});

let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

const clipboardEvent = (text: string) => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  return event;
};

describe("Web Home interactions", () => {
  it("leaves composer paste alone while routing active-page paste and drop", () => {
    const onAddFiles = vi.fn();
    const onAddText = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <HomeView
          user={user}
          state={readyState}
          onRetry={vi.fn()}
          onSignOut={vi.fn()}
          signOutError={null}
          onAddFiles={onAddFiles}
          onAddText={onAddText}
          onDismissUpload={vi.fn()}
          uploadsDisabled={false}
        />,
      ),
    );

    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Paste or write whatever you want"]',
    );
    const main = container.querySelector<HTMLElement>('main[aria-label="Plakk"]');
    expect(input).not.toBeNull();
    expect(main).not.toBeNull();

    const composerPaste = clipboardEvent("edit this first");
    act(() => {
      input?.dispatchEvent(composerPaste);
    });
    expect(composerPaste.defaultPrevented).toBe(false);
    expect(onAddText).not.toHaveBeenCalled();

    const pagePaste = clipboardEvent("publish directly");
    act(() => {
      main?.dispatchEvent(pagePaste);
    });
    expect(pagePaste.defaultPrevented).toBe(true);
    expect(onAddText).toHaveBeenCalledWith("publish directly");

    const file = new File(["file"], "dropped.txt", { type: "text/plain" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });
    act(() => {
      main?.dispatchEvent(drop);
    });
    expect(drop.defaultPrevented).toBe(true);
    expect(onAddFiles).toHaveBeenCalledWith([file]);
  });

  it("keeps a content failure row-local and lets the explicit action retry", async () => {
    const copy = vi
      .fn()
      .mockRejectedValueOnce(
        new WebSnippetActionError({
          cause: null,
          message: "Provider content was interrupted. Try again.",
        }),
      )
      .mockResolvedValue({ kind: "COPIED" as const });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <HomeView
          user={user}
          state={{
            ...readyState,
            snippets: [{ kind: "PUBLISHED", snippet: textSnippet }],
          }}
          onRetry={vi.fn()}
          onSignOut={vi.fn()}
          signOutError={null}
          onAddFiles={vi.fn()}
          onAddText={vi.fn()}
          onDismissUpload={vi.fn()}
          snippetActions={actions({ copy })}
          uploadsDisabled={false}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')?.click();
    });
    expect(container.textContent).toContain("Provider content was interrupted. Try again.");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')?.click();
    });
    expect(copy).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Copied");
  });

  it("requires explicit confirmation before opening a fetched hyperlink in a new tab", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const prepareOpen = vi.fn().mockResolvedValue({ url: "https://example.com/path" });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <HomeView
          user={user}
          state={{
            ...readyState,
            snippets: [{ kind: "PUBLISHED", snippet: textSnippet }],
          }}
          onRetry={vi.fn()}
          onSignOut={vi.fn()}
          signOutError={null}
          onAddFiles={vi.fn()}
          onAddText={vi.fn()}
          onDismissUpload={vi.fn()}
          snippetActions={actions({ open, prepareOpen })}
          uploadsDisabled={false}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Open link"]')?.click();
    });
    expect(prepareOpen).toHaveBeenCalledWith(textSnippet);
    expect(open).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Open external link?");
    expect(document.body.textContent).toContain("example.com");

    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Open link",
    );
    await act(async () => {
      confirm?.click();
    });
    expect(open).toHaveBeenCalledWith("https://example.com/path");
  });

  it("keeps Delete enabled while storage restrictions disable content actions", async () => {
    const deleteSnippet = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <HomeView
          user={user}
          state={{
            ...readyState,
            account: { ...account, blockedReasons: ["storage"], canSync: false },
            snippets: [{ kind: "PUBLISHED", snippet: textSnippet }],
          }}
          onRetry={vi.fn()}
          onSignOut={vi.fn()}
          signOutError={null}
          onAddFiles={vi.fn()}
          onAddText={vi.fn()}
          onDismissUpload={vi.fn()}
          snippetActions={actions({ delete: deleteSnippet })}
          uploadsDisabled
        />,
      );
    });

    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')?.disabled).toBe(
      true,
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')?.disabled,
    ).toBe(false);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')?.click();
    });
    expect(deleteSnippet).toHaveBeenCalledWith(textSnippet.id);
  });
});
