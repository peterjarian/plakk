import type { LocalUploadRecord, User } from "@plakk/shared";
import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { HomeView } from "./HomeView.tsx";
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

const photo: ApiSnippet = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "Summer photo.png",
  byteSize: 1024,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "photo-object",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};
const photoRecord = { kind: "PUBLISHED" as const, snippet: photo };
const localUpload = (id: string, status: LocalUploadRecord["status"]): LocalUploadRecord => ({
  kind: "LOCAL",
  id,
  fileName: `${status.toLowerCase()}.txt`,
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE",
  status,
  errorMessage: status === "FAILED" ? "Provider transfer failed." : null,
  publicationCandidate: null,
  createdAt: "2026-07-27T01:00:00.000Z",
  updatedAt: "2026-07-27T01:00:00.000Z",
});

const snippetActions = {
  copy: vi.fn().mockResolvedValue({ kind: "COPIED" as const }),
  delete: vi.fn().mockResolvedValue(undefined),
  download: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(undefined),
  prepareOpen: vi.fn().mockResolvedValue({ url: "https://example.com" }),
} satisfies NonNullable<WebProductContextValue["snippetActions"]>;

const render = (
  state: Parameters<typeof HomeView>[0]["state"],
  actions: WebProductContextValue["snippetActions"] = null,
  overrides: Partial<Parameters<typeof HomeView>[0]> = {},
) =>
  renderToStaticMarkup(
    <HomeView
      user={user}
      state={state}
      onRetry={vi.fn()}
      onSignOut={vi.fn()}
      signOutError={null}
      onAddFiles={vi.fn()}
      onAddText={vi.fn()}
      onDismissUpload={vi.fn()}
      snippetActions={actions}
      uploadsDisabled={false}
      {...overrides}
    />,
  );

const actionTag = (html: string, label: string) =>
  html.match(new RegExp(`<button(?=[^>]*aria-label="${label}")[^>]*>`))?.[0] ?? "";

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
      snippets: [photoRecord],
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
      snippets: [photoRecord],
    });
    expect(html).toContain("Summer photo.png");
    expect(html).toContain("Google Drive");
    expect(html).not.toContain('aria-label="Copy"');
    expect(html).not.toContain('aria-label="Delete"');
  });

  it("renders browser-appropriate content actions and authoritative Delete", () => {
    const html = render(
      {
        account,
        accountId: user.id,
        apiAvailability: "available",
        kind: "ready",
        liveConnection: "connected",
        localReadPerformance: "accelerated",
        snippets: [photoRecord],
      },
      snippetActions,
    );

    expect(html).toContain('aria-label="Copy"');
    expect(html).toContain('aria-label="Delete"');
    expect(html).not.toContain('aria-label="Download"');
  });

  it("renders uploading and dismissible failed page-lifetime records honestly", () => {
    const html = render({
      account,
      accountId: user.id,
      apiAvailability: "available",
      kind: "ready",
      liveConnection: "connected",
      localReadPerformance: "accelerated",
      snippets: [
        localUpload("1d1e2f3a-4567-4890-8abc-def012345679", "UPLOADING"),
        localUpload("2d1e2f3a-4567-4890-8abc-def012345670", "FAILED"),
      ],
    });

    expect(html).toContain("Text snippet");
    expect(html).toContain('aria-label="Syncing"');
    expect(html).toContain("Provider transfer failed.");
    expect(html).toContain('aria-label="Dismiss failed upload"');
  });

  it("presents the active account trial and its backend-provided end instant", () => {
    const html = render({
      account,
      accountId: user.id,
      apiAvailability: "available",
      kind: "ready",
      liveConnection: "connected",
      localReadPerformance: "accelerated",
      snippets: [photoRecord],
    });

    expect(html).toContain("Trial active");
    expect(html).toContain("August 10, 2026");
    expect(html).not.toContain("Billing access required");
  });

  it("keeps Snippets visible and gives honest recovery direction when billing is restricted", () => {
    const html = render(
      {
        account: {
          ...account,
          accessEntitlement: {
            ...account.accessEntitlement,
            status: "BILLING_RESTRICTED",
          },
          blockedReasons: ["billing"],
          canSync: false,
        },
        accountId: user.id,
        apiAvailability: "available",
        kind: "ready",
        liveConnection: "connected",
        localReadPerformance: "accelerated",
        snippets: [photoRecord],
      },
      snippetActions,
    );

    expect(html).toContain("Billing access required");
    expect(html).toContain("Summer photo.png");
    expect(html).toContain("Your snippets are preserved");
    expect(html).toContain("Restore billing access");
    expect(html).toContain("Add, Copy, Download, and Open remain unavailable");
    expect(actionTag(html, "Copy")).toContain('disabled=""');
    expect(actionTag(html, "Delete")).not.toContain('disabled=""');
  });

  it("gates every provider-dependent action during storage restriction", () => {
    const html = render(
      {
        account: {
          ...account,
          blockedReasons: ["storage"],
          canSync: false,
        },
        accountId: user.id,
        apiAvailability: "available",
        kind: "ready",
        liveConnection: "connected",
        localReadPerformance: "accelerated",
        snippets: [photoRecord],
      },
      snippetActions,
      { onStorageReconnect: vi.fn() },
    );

    expect(html).toContain("Storage access required");
    expect(html).toContain("Copy, Download, Open, and Delete");
    expect(html).toContain(">Reconnect storage</button>");
    expect(actionTag(html, "Copy")).toContain('disabled=""');
    expect(actionTag(html, "Delete")).toContain('disabled=""');
  });

  it("keeps last-confirmed snippets visible while live updates reconnect", () => {
    const html = render({
      account,
      accountId: user.id,
      apiAvailability: "available",
      kind: "ready",
      liveConnection: "reconnecting",
      localReadPerformance: "accelerated",
      snippets: [photoRecord],
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
      snippets: [photoRecord],
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
        onAddFiles={vi.fn()}
        onAddText={vi.fn()}
        onDismissUpload={vi.fn()}
        uploadsDisabled
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
        onAddFiles={vi.fn()}
        onAddText={vi.fn()}
        onDismissUpload={vi.fn()}
        uploadsDisabled
      />,
    );
    expect(html).toContain("could not confirm");
    expect(html).toContain("sign-out was stopped");
    expect(html).not.toContain("WorkOS could not sign you out");
  });
});
