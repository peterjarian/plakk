import { WEB_SNIPPET_CONTENT_MAX_BYTES, type ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  WebSnippetActionBrowser,
  WebSnippetBrowserError,
  type WebSnippetActionFailure,
  WebSnippetActionRemote,
  WebSnippetActions,
} from "./snippet-actions.ts";

const snippet = (overrides: Partial<ApiSnippet> = {}): ApiSnippet => ({
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "note.txt",
  byteSize: 5,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-object",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  ...overrides,
});

const run = (
  content: Uint8Array,
  use: (actions: WebSnippetActions["Service"]) => Effect.Effect<unknown, WebSnippetActionFailure>,
  options: {
    readonly browser?: Partial<WebSnippetActionBrowser["Service"]>;
    readonly response?: Partial<{
      readonly storageProvider: ApiSnippet["storageProvider"];
      readonly fileName: string;
      readonly byteSize: number;
    }>;
    readonly read?: WebSnippetActionRemote["Service"]["read"];
  } = {},
) => {
  const browser = WebSnippetActionBrowser.of({
    copyImage: (image) =>
      Effect.tryPromise({
        try: () => image,
        catch: (cause) => new WebSnippetBrowserError({ cause, message: "image failure" }),
      }).pipe(Effect.as("COPIED")),
    copyText: (text) =>
      Effect.tryPromise({
        try: () => text,
        catch: (cause) => new WebSnippetBrowserError({ cause, message: "text failure" }),
      }).pipe(Effect.asVoid),
    download: () => Effect.void,
    open: () => Effect.void,
    ...options.browser,
  });
  const remote = WebSnippetActionRemote.of({
    delete: () => Effect.void,
    read:
      options.read ??
      (() =>
        Effect.succeed({
          storageProvider: "GOOGLE_DRIVE",
          fileName: "note.txt",
          byteSize: content.byteLength,
          content,
          ...options.response,
        })),
  });

  return Effect.runPromise(
    Effect.flatMap(WebSnippetActions, use).pipe(
      Effect.provide(
        WebSnippetActions.layer.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(WebSnippetActionBrowser, browser),
              Layer.succeed(WebSnippetActionRemote, remote),
            ),
          ),
        ),
      ),
    ),
  );
};

describe("Web Snippet actions", () => {
  it("fetches complete text for one explicit Copy and retains no content between actions", async () => {
    const content = new TextEncoder().encode("hello");
    const read = vi.fn(() =>
      Effect.succeed({
        storageProvider: "GOOGLE_DRIVE" as const,
        fileName: "note.txt",
        byteSize: content.byteLength,
        content,
      }),
    );
    const copyText = vi.fn((text: Promise<string>) =>
      Effect.tryPromise({
        try: () => text,
        catch: (cause) => new WebSnippetBrowserError({ cause, message: "text failure" }),
      }).pipe(Effect.asVoid),
    );

    await run(content, (actions) => actions.copy(snippet()), {
      browser: { copyText },
      read,
    });
    await run(content, (actions) => actions.copy(snippet()), {
      browser: { copyText },
      read,
    });

    expect(read).toHaveBeenCalledTimes(2);
    await expect(copyText.mock.calls[0]?.[0]).resolves.toBe("hello");
    await expect(copyText.mock.calls[1]?.[0]).resolves.toBe("hello");
  });

  it("derives and confirms a hyperlink from complete content before opening it", async () => {
    const content = new TextEncoder().encode(" https://example.com/path ");
    const open = vi.fn(() => Effect.void);
    const target = snippet({ byteSize: content.byteLength });

    const prepared = await run(content, (actions) => actions.prepareOpen(target));
    await run(content, (actions) => actions.open("https://example.com/path"), {
      browser: { open },
    });

    expect(prepared).toEqual({ url: "https://example.com/path" });
    expect(open).toHaveBeenCalledWith("https://example.com/path");
  });

  it("copies a decodable image when supported and downloads an honest capability fallback", async () => {
    const content = new Uint8Array([1, 2, 3, 4]);
    const target = snippet({ fileName: "photo.png", byteSize: content.byteLength });
    const copyImage = vi.fn(() => Effect.succeed<"COPIED" | "UNSUPPORTED">("COPIED"));
    const download = vi.fn(() => Effect.void);

    await expect(
      run(content, (actions) => actions.copy(target), {
        browser: { copyImage, download },
        response: { fileName: target.fileName },
      }),
    ).resolves.toEqual({ kind: "COPIED" });

    copyImage.mockReturnValue(Effect.succeed("UNSUPPORTED"));
    await expect(
      run(content, (actions) => actions.copy(target), {
        browser: { copyImage, download },
        response: { fileName: target.fileName },
      }),
    ).resolves.toEqual({ kind: "DOWNLOADED_IMAGE_FALLBACK" });
    expect(download).toHaveBeenCalledWith(content, "photo.png");
  });

  it("downloads an image when browser decoding or clipboard conversion fails", async () => {
    const content = new Uint8Array([1, 2, 3, 4]);
    const target = snippet({ fileName: "photo.png", byteSize: content.byteLength });
    const download = vi.fn(() => Effect.void);

    await expect(
      run(content, (actions) => actions.copy(target), {
        browser: {
          copyImage: () =>
            Effect.fail(
              new WebSnippetBrowserError({
                cause: new Error("decode failed"),
                message: "This image could not be copied in this browser.",
              }),
            ),
          download,
        },
        response: { fileName: target.fileName },
      }),
    ).resolves.toEqual({ kind: "DOWNLOADED_IMAGE_FALLBACK" });
    expect(download).toHaveBeenCalledWith(content, "photo.png");
  });

  it("downloads arbitrary named files instead of offering file clipboard semantics", async () => {
    const content = new Uint8Array([1, 2, 3]);
    const target = snippet({ fileName: "Quarterly report.pdf", byteSize: content.byteLength });
    const download = vi.fn(() => Effect.void);

    await run(content, (actions) => actions.download(target), {
      browser: { download },
      response: { fileName: target.fileName },
    });

    expect(download).toHaveBeenCalledWith(content, "Quarterly report.pdf");
  });

  it("rejects oversized buffered Copy content before invoking the remote", async () => {
    const read = vi.fn(() => Effect.die("must not read oversized content"));
    const target = snippet({
      byteSize: WEB_SNIPPET_CONTENT_MAX_BYTES + 1,
      fileName: "oversized.txt",
    });

    await expect(
      run(new Uint8Array(), (actions) => actions.copy(target), {
        read,
      }),
    ).rejects.toMatchObject({
      _tag: "WebSnippetActionError",
      message:
        "This snippet is too large for browser Copy. Download it from the storage provider instead.",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("downloads a text-named file when complete content is not decodable text", async () => {
    const content = new Uint8Array([0xff, 0xfe]);
    const target = snippet({ byteSize: content.byteLength });
    const download = vi.fn(() => Effect.void);

    await expect(
      run(content, (actions) => actions.copy(target), {
        browser: { download },
      }),
    ).resolves.toEqual({ kind: "DOWNLOADED_FILE_FALLBACK" });
    expect(download).toHaveBeenCalledWith(content, "note.txt");
  });

  it("rejects metadata and complete-size mismatches without writing clipboard content", async () => {
    const content = new TextEncoder().encode("hello");
    const copyText = vi.fn((text: Promise<string>) =>
      Effect.tryPromise({
        try: () => text,
        catch: (cause) => new WebSnippetBrowserError({ cause, message: "text failure" }),
      }).pipe(Effect.asVoid),
    );

    await expect(
      run(content, (actions) => actions.copy(snippet()), {
        browser: { copyText },
        response: { byteSize: content.byteLength + 1 },
      }),
    ).rejects.toMatchObject({
      _tag: "WebSnippetActionError",
      message: "The downloaded content did not match this snippet. Try again.",
    });
    expect(copyText).toHaveBeenCalledOnce();
  });

  it("keeps remote content failures honest and retryable", async () => {
    await expect(
      run(new Uint8Array(), (actions) => actions.copy(snippet()), {
        read: () =>
          Effect.fail(
            new RpcError({
              code: "INTERNAL_SERVER_ERROR",
              message: "provider unavailable",
            }),
          ),
      }),
    ).rejects.toMatchObject({
      _tag: "RpcError",
      code: "INTERNAL_SERVER_ERROR",
      message: "provider unavailable",
    });
  });
});
