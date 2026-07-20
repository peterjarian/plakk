import { SNIPPET_TEXT_PREVIEW_MAX_BYTES } from "@plakk/shared";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DesktopSnippet } from "../../ipc/contracts.ts";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
  type ManagedTextValidation,
} from "./content/ManagedSnippetContent.ts";
import { projectDesktopManagedContent } from "./SnippetProjection.ts";

const accountId = "account-1";
const snippet: DesktopSnippet = {
  id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
  fileName: "private-notes.md",
  byteSize: 5,
  storageProvider: "GOOGLE_DRIVE",
  kind: "PUBLISHED",
  createdAt: "2026-07-16T10:00:00.000Z",
  updatedAt: "2026-07-16T10:00:00.000Z",
  localState: null,
  localTextPreview: null,
  localContentAvailability: { status: "NOT_AVAILABLE" },
};

const contentLayer = (
  bytes: Uint8Array | null,
  getPrefix: () => Effect.Effect<Uint8Array | null, ManagedSnippetContentError> = vi.fn(() =>
    Effect.succeed(bytes),
  ),
  validation: ManagedTextValidation = "VALID",
) => ({
  getPrefix,
  layer: Layer.succeed(
    ManagedSnippetContent,
    ManagedSnippetContent.of({
      get: () => Effect.succeed(bytes),
      changes: Stream.empty,
      getPrefix,
      putStream: () => Effect.void,
      available: () => Effect.succeed(bytes !== null),
      invalidate: () => Effect.void,
      discard: () => Effect.void,
      ingest: () => Effect.succeed("/managed/content"),
      path: () => Effect.succeed("/managed/content"),
      purge: () => Effect.void,
      validateText: () => Effect.succeed(validation),
    }),
  ),
});

describe("desktop snippet content projection", () => {
  it("reveals text presentation only after complete managed content decodes", async () => {
    const content = contentLayer(new TextEncoder().encode("hello"));

    const projected = await Effect.runPromise(
      projectDesktopManagedContent(accountId, snippet, { status: "AVAILABLE" }).pipe(
        Effect.provide(content.layer),
      ),
    );

    expect(projected).toMatchObject({
      localTextPreview: "hello",
      localContentAvailability: { status: "AVAILABLE" },
    });
  });

  it("keeps valid managed bytes available when their text presentation is invalid", async () => {
    const content = contentLayer(
      new Uint8Array(5).fill(0xff),
      vi.fn(() => Effect.succeed(new Uint8Array(5).fill(0xff))),
      "INVALID",
    );

    const projected = await Effect.runPromise(
      projectDesktopManagedContent(accountId, snippet, { status: "AVAILABLE" }).pipe(
        Effect.provide(content.layer),
      ),
    );

    expect(projected).toMatchObject({
      localTextPreview: null,
      localContentAvailability: { status: "AVAILABLE" },
    });
  });

  it("does not project text when UTF-8 becomes invalid after the bounded preview", async () => {
    const preview = new TextEncoder().encode(
      "Valid preview".padEnd(SNIPPET_TEXT_PREVIEW_MAX_BYTES),
    );
    const content = contentLayer(
      preview,
      vi.fn(() => Effect.succeed(preview)),
      "INVALID",
    );

    const projected = await Effect.runPromise(
      projectDesktopManagedContent(
        accountId,
        { ...snippet, byteSize: SNIPPET_TEXT_PREVIEW_MAX_BYTES + 1 },
        { status: "AVAILABLE" },
      ).pipe(Effect.provide(content.layer)),
    );

    expect(projected).toMatchObject({
      localTextPreview: null,
      localContentAvailability: { status: "AVAILABLE" },
    });
  });

  it("does not read or classify text before managed content is available", async () => {
    const getPrefix = vi.fn(() => Effect.succeed<Uint8Array | null>(null));
    const content = contentLayer(null, getPrefix);

    const projected = await Effect.runPromise(
      projectDesktopManagedContent(accountId, snippet, { status: "DOWNLOADING" }).pipe(
        Effect.provide(content.layer),
      ),
    );

    expect(projected).toMatchObject({
      localTextPreview: null,
      localContentAvailability: { status: "DOWNLOADING" },
    });
    expect(getPrefix).not.toHaveBeenCalled();
  });

  it("keeps metadata visible when one local content read fails", async () => {
    const getPrefix = vi.fn(() =>
      Effect.fail(
        new ManagedSnippetContentError({
          cause: null,
          reason: "Could not read managed snippet content.",
          retryable: true,
        }),
      ),
    );
    const content = contentLayer(null, getPrefix);

    const projected = await Effect.runPromise(
      projectDesktopManagedContent(accountId, snippet, { status: "AVAILABLE" }).pipe(
        Effect.provide(content.layer),
      ),
    );

    expect(projected).toMatchObject({
      id: snippet.id,
      localTextPreview: null,
      localContentAvailability: {
        status: "FAILED",
        message: "Could not read managed snippet content.",
      },
    });
  });

  it("projects a bounded preview instead of reading a permitted large text file in full", async () => {
    const preview = new TextEncoder().encode(
      "Large text title\n".padEnd(SNIPPET_TEXT_PREVIEW_MAX_BYTES, "x"),
    );
    const getPrefix = vi.fn(() => Effect.succeed<Uint8Array | null>(preview));
    const content = contentLayer(preview, getPrefix);

    const projected = await Effect.runPromise(
      projectDesktopManagedContent(
        accountId,
        { ...snippet, byteSize: SNIPPET_TEXT_PREVIEW_MAX_BYTES + 1 },
        { status: "AVAILABLE" },
      ).pipe(Effect.provide(content.layer)),
    );

    expect(getPrefix).toHaveBeenCalledWith(accountId, snippet.id, SNIPPET_TEXT_PREVIEW_MAX_BYTES);
    expect(projected.localTextPreview).toHaveLength(preview.byteLength);
  });
});
