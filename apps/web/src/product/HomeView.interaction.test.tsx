// @vitest-environment happy-dom

import type { User } from "@plakk/shared";
import type { AccountStatus } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { HomeView } from "./HomeView.tsx";

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
});
