import { ManagedSnippetContent, ManagedSnippetContentError } from "@plakk/shared/SnippetReplica";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DesktopSnippet } from "../ipc/contracts.ts";
import { projectDesktopManagedContent } from "./SnippetProjection.ts";

const accountId = "account-1";
const snippet: DesktopSnippet = {
  id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
  fileName: "private-notes.md",
  byteSize: 5,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "provider-file",
  uploadStatus: "UPLOADED",
  createdAt: "2026-07-16T10:00:00.000Z",
  updatedAt: "2026-07-16T10:00:00.000Z",
  localState: null,
  localTextContent: null,
  localContentAvailability: { status: "NOT_AVAILABLE" },
};

const contentLayer = (
  bytes: Uint8Array | null,
  get: () => Effect.Effect<Uint8Array | null, ManagedSnippetContentError> = vi.fn(() =>
    Effect.succeed(bytes),
  ),
) => ({
  get,
  layer: Layer.succeed(
    ManagedSnippetContent,
    ManagedSnippetContent.of({
      get,
      putStream: () => Effect.void,
      available: () => Effect.succeed(bytes !== null),
      invalidate: () => Effect.void,
    }),
  ),
});

describe("desktop snippet content projection", () => {
  it("preserves the origin importing text projection before managed bytes are committed", async () => {
    const get = vi.fn(() => Effect.succeed<Uint8Array | null>(null));
    const content = contentLayer(null, get);
    const {
      localTextContent: _localTextContent,
      localContentAvailability: _localContentAvailability,
      ...metadata
    } = snippet;

    const projected = await Effect.runPromise(
      projectDesktopManagedContent(
        accountId,
        {
          ...metadata,
          importingContent: {
            localTextContent: "hello from origin",
            localContentAvailability: { status: "AVAILABLE" },
          },
        },
        { status: "NOT_AVAILABLE" },
      ).pipe(Effect.provide(content.layer)),
    );

    expect(projected).toMatchObject({
      localTextContent: "hello from origin",
      localContentAvailability: { status: "AVAILABLE" },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("reveals text presentation only after complete managed content decodes", async () => {
    const content = contentLayer(new TextEncoder().encode("hello"));

    const projected = await Effect.runPromise(
      projectDesktopManagedContent(accountId, snippet, { status: "AVAILABLE" }).pipe(
        Effect.provide(content.layer),
      ),
    );

    expect(projected).toMatchObject({
      localTextContent: "hello",
      localContentAvailability: { status: "AVAILABLE" },
    });
  });

  it("turns same-size invalid UTF-8 into a retryable local presentation failure", async () => {
    const content = contentLayer(new Uint8Array(5).fill(0xff));

    const projected = await Effect.runPromise(
      projectDesktopManagedContent(accountId, snippet, { status: "AVAILABLE" }).pipe(
        Effect.provide(content.layer),
      ),
    );

    expect(projected).toMatchObject({
      localTextContent: null,
      localContentAvailability: {
        status: "FAILED",
        message: "This text file is not valid UTF-8. Download it again.",
      },
    });
  });

  it("does not read or classify text before managed content is available", async () => {
    const get = vi.fn(() => Effect.succeed<Uint8Array | null>(null));
    const content = contentLayer(null, get);

    const projected = await Effect.runPromise(
      projectDesktopManagedContent(accountId, snippet, { status: "DOWNLOADING" }).pipe(
        Effect.provide(content.layer),
      ),
    );

    expect(projected).toMatchObject({
      localTextContent: null,
      localContentAvailability: { status: "DOWNLOADING" },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps metadata visible when one local content read fails", async () => {
    const get = vi.fn(() =>
      Effect.fail(
        new ManagedSnippetContentError({
          cause: null,
          reason: "Could not read managed snippet content.",
          retryable: true,
        }),
      ),
    );
    const content = contentLayer(null, get);

    const projected = await Effect.runPromise(
      projectDesktopManagedContent(accountId, snippet, { status: "AVAILABLE" }).pipe(
        Effect.provide(content.layer),
      ),
    );

    expect(projected).toMatchObject({
      id: snippet.id,
      localTextContent: null,
      localContentAvailability: {
        status: "FAILED",
        message: "Could not read managed snippet content.",
      },
    });
  });
});
