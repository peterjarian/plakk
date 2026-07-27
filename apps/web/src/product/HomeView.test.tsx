import type { User } from "@plakk/shared";
import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
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
    <HomeView
      user={user}
      state={state}
      onRetry={vi.fn()}
      onSignOut={vi.fn()}
      signOutError={null}
    />,
  );

describe("Web Home", () => {
  it("renders loading without presenting an empty account", () => {
    const html = render({ accountId: user.id, kind: "loading" });
    expect(html).toContain("Loading snippets");
    expect(html).not.toContain("Nothing added yet");
  });

  it("renders a retryable product-load failure without assuming an API outage", () => {
    const html = render({
      accountId: user.id,
      cause: new RpcError({
        code: "INTERNAL_SERVER_ERROR",
        message: "backend unavailable",
      }),
      kind: "failed",
    });
    expect(html).toContain(">WR<");
    expect(html).toContain("Product unavailable");
    expect(html).toContain("Plakk couldn’t load your snippets.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("API unavailable");
    expect(html).not.toContain("Nothing added yet");
  });

  it("renders the established empty state for a confirmed empty snapshot", () => {
    const html = render({
      account,
      accountId: user.id,
      apiAvailability: "available",
      kind: "ready",
      liveConnection: "connected",
      localReadPerformance: "accelerated",
      snippets: [],
    });
    expect(html).toContain("Nothing added yet");
    expect(html).toContain("Published snippets from your Plakk account will appear here.");
    expect(html).not.toContain("Add something above");
    expect(html).toContain("Live updates connected");
    expect(html).not.toContain("Fast local reads are unavailable");
  });

  it("reports session-memory fallback without hiding confirmed snippets", () => {
    const html = render({
      account,
      accountId: user.id,
      apiAvailability: "available",
      kind: "ready",
      liveConnection: "connected",
      localReadPerformance: "degraded",
      snippets: [photo],
    });
    expect(html).toContain("Fast local reads are unavailable");
    expect(html).toContain("Summer photo.png");
  });

  it("renders account-owned published Snippets without mutation actions", () => {
    const html = render({
      account,
      accountId: user.id,
      apiAvailability: "available",
      kind: "ready",
      liveConnection: "connected",
      localReadPerformance: "accelerated",
      snippets: [photo],
    });
    expect(html).toContain("Summer photo.png");
    expect(html).toContain("Google Drive");
    expect(html).not.toContain('aria-label="Copy"');
    expect(html).not.toContain('aria-label="Delete"');
  });

  it("keeps last-confirmed snippets visible while live updates reconnect", () => {
    const html = render({
      account,
      accountId: user.id,
      apiAvailability: "available",
      kind: "ready",
      liveConnection: "reconnecting",
      localReadPerformance: "accelerated",
      snippets: [photo],
    });
    expect(html).toContain("Summer photo.png");
    expect(html).toContain("Live updates reconnecting");
    expect(html).toContain("last-confirmed snippets remain visible");
    expect(html).not.toContain("API unavailable");
  });

  it("keeps last-confirmed snippets visible during an API outage", () => {
    const html = render({
      account,
      accountId: user.id,
      apiAvailability: "unavailable",
      cause: new RpcError({
        code: "INTERNAL_SERVER_ERROR",
        message: "backend unavailable",
      }),
      kind: "ready",
      liveConnection: "connected",
      localReadPerformance: "accelerated",
      snippets: [photo],
    });
    expect(html).toContain("Summer photo.png");
    expect(html).toContain("API unavailable");
    expect(html).toContain("Showing your last-confirmed snippets");
    expect(html).toContain("Remote actions are paused");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Nothing added yet");
  });

  it("keeps a delegated sign-out failure visible and retryable", () => {
    const html = renderToStaticMarkup(
      <HomeView
        user={user}
        state={{ kind: "idle" }}
        onRetry={null}
        onSignOut={vi.fn()}
        signOutError="workos"
      />,
    );
    expect(html).toContain("WorkOS could not sign you out");
    expect(html).toContain("Try signing out again");
  });

  it("distinguishes a fail-closed product purge from a WorkOS failure", () => {
    const html = renderToStaticMarkup(
      <HomeView
        user={user}
        state={{ kind: "idle" }}
        onRetry={null}
        onSignOut={vi.fn()}
        signOutError="product-purge"
      />,
    );
    expect(html).toContain("could not confirm");
    expect(html).toContain("sign-out was stopped");
    expect(html).not.toContain("WorkOS could not sign you out");
  });
});
