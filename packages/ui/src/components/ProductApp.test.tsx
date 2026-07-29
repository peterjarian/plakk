import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ProductApp, type ProductAppProps } from "./ProductApp.tsx";

const user = {
  id: "user-1",
  firstName: "Web",
  lastName: "User",
  email: "web@example.com",
  createdAt: "2026-07-20T18:00:00.000Z",
  updatedAt: "2026-07-20T18:00:00.000Z",
} as const;

const props = {
  appearance: "system",
  capability: {
    status: "ONLINE",
    account: {
      canSync: true,
      storageProvider: "GOOGLE_DRIVE",
      blockedReasons: [],
    },
    connection: {
      storageProvider: "GOOGLE_DRIVE",
      status: "CONNECTED",
      externalDestinationUrl: "https://drive.google.com/drive/folders/plakk",
    },
  },
  error: null,
  loading: false,
  snippets: [
    {
      id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
      fileName: "snippet.txt",
      byteSize: 14,
      storageProvider: "GOOGLE_DRIVE",
      kind: "PUBLISHED",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
      localState: null,
      localContentAvailability: { status: "NOT_AVAILABLE" },
      presentation: { type: "text", title: "A web snippet" },
    },
  ],
  syncStatus: "CONNECTED",
  user,
  onAppearanceChange: vi.fn(),
  onCopy: vi.fn(),
  onDelete: vi.fn(),
  onDownload: vi.fn(),
  onFiles: vi.fn(),
  onOpenExternal: vi.fn(),
  onRefresh: vi.fn(),
  onSignIn: vi.fn(),
  onSignOut: vi.fn(),
  onText: vi.fn(),
} satisfies ProductAppProps;

describe("ProductApp", () => {
  it("renders the WorkOS entry surface while signed out", () => {
    const markup = renderToStaticMarkup(<ProductApp {...props} user={null} />);

    expect(markup).toContain("Move snippets between devices.");
    expect(markup).toContain(">Sign in<");
  });

  it("keeps remote snippet actions available without local content", () => {
    const markup = renderToStaticMarkup(<ProductApp {...props} />);

    expect(markup).toContain("A web snippet");
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).toContain('aria-label="Download"');
    expect(markup).not.toContain("Download to this device");
    expect(markup).not.toContain("Downloading for offline access");
  });

  it("presents binary remote content as a download rather than a copy", () => {
    const snippet = {
      ...props.snippets[0]!,
      fileName: "archive.zip",
      presentation: { type: "file", title: "archive.zip" } as const,
    };
    const markup = renderToStaticMarkup(<ProductApp {...props} snippets={[snippet]} />);

    expect(markup).not.toContain('aria-label="Copy"');
    expect(markup).toContain('aria-label="Download"');
  });

  it("routes billing-blocked accounts to billing recovery", () => {
    const markup = renderToStaticMarkup(
      <ProductApp
        {...props}
        capability={{
          ...props.capability,
          account: {
            ...props.capability.account,
            canSync: false,
            blockedReasons: ["billing"],
          },
        }}
      />,
    );

    expect(markup).toContain("Sync is paused until billing is resolved.");
    expect(markup).toContain("Manage billing");
  });
});
