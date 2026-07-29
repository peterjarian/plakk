import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { usePlakk } from "../hooks/usePlakk.ts";
import { Home } from "./Home.tsx";
import { Welcome } from "./Welcome.tsx";

const plakk = {
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
  user: {
    id: "user-1",
    firstName: "Web",
    lastName: "User",
    email: "web@example.com",
    createdAt: "2026-07-20T18:00:00.000Z",
    updatedAt: "2026-07-20T18:00:00.000Z",
  },
  changeAppearance: vi.fn(),
  connectStorage: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  refresh: vi.fn(),
  addText: vi.fn(),
  addFiles: vi.fn(),
  deleteSnippet: vi.fn(),
  copySnippet: vi.fn(),
  downloadSnippet: vi.fn(),
  openExternal: vi.fn(),
} as unknown as ReturnType<typeof usePlakk>;

describe("web screens", () => {
  it("renders the WorkOS entry surface while signed out", () => {
    const markup = renderToStaticMarkup(
      <Welcome error={null} loading={false} onSignIn={vi.fn()} />,
    );

    expect(markup).toContain("Move snippets between devices.");
    expect(markup).toContain(">Sign in<");
  });

  it("keeps remote snippet actions available without local content", () => {
    const markup = renderToStaticMarkup(<Home plakk={plakk} onSettings={vi.fn()} />);

    expect(markup).toContain("A web snippet");
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).toContain('aria-label="Download"');
    expect(markup).not.toContain("Download to this device");
  });

  it("presents binary remote content as a download rather than a copy", () => {
    const binary = {
      ...plakk,
      snippets: [
        {
          ...plakk.snippets[0]!,
          fileName: "archive.zip",
          presentation: { type: "file", title: "archive.zip" } as const,
        },
      ],
    };
    const markup = renderToStaticMarkup(<Home plakk={binary} onSettings={vi.fn()} />);

    expect(markup).not.toContain('aria-label="Copy"');
    expect(markup).toContain('aria-label="Download"');
  });

  it("routes billing-blocked accounts to billing recovery", () => {
    const blocked = {
      ...plakk,
      capability: {
        status: "ONLINE",
        account: {
          canSync: false,
          storageProvider: "GOOGLE_DRIVE",
          blockedReasons: ["billing"],
        },
        connection: {
          storageProvider: "GOOGLE_DRIVE",
          status: "CONNECTED",
          externalDestinationUrl: "https://drive.google.com/drive/folders/plakk",
        },
      },
    } as ReturnType<typeof usePlakk>;
    const markup = renderToStaticMarkup(<Home plakk={blocked} onSettings={vi.fn()} />);

    expect(markup).toContain("Sync is paused until billing is resolved.");
    expect(markup).toContain("Manage billing");
  });
});
