import type { User } from "@plakk/shared";
import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

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
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
  blockedReasons: [],
};

const photo: ApiSnippet = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "Summer photo.png",
  byteSize: 1024,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "photo-object",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const render = (state: Parameters<typeof HomeView>[0]["state"]) =>
  renderToStaticMarkup(
    <HomeView user={user} state={state} onRetry={vi.fn()} onSignOut={vi.fn()} />,
  );

describe("Web Home", () => {
  it("renders loading without presenting an empty account", () => {
    const html = render({ accountId: user.id, kind: "loading" });
    expect(html).toContain("Loading snippets");
    expect(html).not.toContain("Nothing added yet");
  });

  it("renders a retryable failure inside the product shell", () => {
    const html = render({
      accountId: user.id,
      kind: "failed",
      message: "Plakk couldn’t load your snippets.",
    });
    expect(html).toContain(">WR<");
    expect(html).toContain("Plakk couldn’t load your snippets.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Nothing added yet");
  });

  it("renders the established empty state for a confirmed empty snapshot", () => {
    expect(render({ account, accountId: user.id, kind: "ready", snippets: [] })).toContain(
      "Nothing added yet",
    );
  });

  it("renders account-owned published Snippets without mutation actions", () => {
    const html = render({
      account,
      accountId: user.id,
      kind: "ready",
      snippets: [photo],
    });
    expect(html).toContain("Summer photo.png");
    expect(html).toContain("Google Drive");
    expect(html).not.toContain('aria-label="Copy"');
    expect(html).not.toContain('aria-label="Delete"');
  });
});
