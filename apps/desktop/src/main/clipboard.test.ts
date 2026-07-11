import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

const electron = vi.hoisted(() => ({
  clear: vi.fn(),
  writeBuffer: vi.fn(),
  writeImage: vi.fn(),
  createFromBuffer: vi.fn(),
  getPath: vi.fn(() => "/tmp"),
  fetch: vi.fn(),
}));

const fs = vi.hoisted(() => ({ writeFileSync: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeFileSync: fs.writeFileSync,
}));

vi.mock("electron", () => ({
  app: { getPath: electron.getPath },
  clipboard: {
    clear: electron.clear,
    writeBuffer: electron.writeBuffer,
    writeImage: electron.writeImage,
  },
  nativeImage: { createFromBuffer: electron.createFromBuffer },
  net: { fetch: electron.fetch },
}));

import { downloadSnippetToClipboard, writeSnippetToClipboard } from "./clipboard.ts";

describe("stored snippet clipboard writes", () => {
  it("writes decodable images as native images", async () => {
    const image = { isEmpty: () => false };
    electron.createFromBuffer.mockReturnValue(image);

    await Effect.runPromise(
      writeSnippetToClipboard({
        bytes: new Uint8Array([1]),
        kind: "IMAGE",
        fileName: "photo.png",
        contentType: "image/png",
      }),
    );

    expect(electron.writeImage).toHaveBeenCalledWith(image);
    expect(electron.writeBuffer).not.toHaveBeenCalled();
  });

  it("preserves unsupported image bytes in a MIME clipboard format", async () => {
    electron.createFromBuffer.mockReturnValue({ isEmpty: () => true });

    await Effect.runPromise(
      writeSnippetToClipboard({
        bytes: new Uint8Array([1, 2]),
        kind: "IMAGE",
        fileName: "photo.avif",
        contentType: "image/avif",
      }),
    );

    expect(electron.clear).toHaveBeenCalled();
    expect(electron.writeBuffer).toHaveBeenCalledWith("image/avif", Buffer.from([1, 2]));
  });

  it("materializes files and writes a native file URL", async () => {
    await Effect.runPromise(
      writeSnippetToClipboard({
        bytes: new Uint8Array([1, 2]),
        kind: "FILE",
        fileName: "report.pdf",
        contentType: "application/pdf",
      }),
    );

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("-report.pdf"),
      new Uint8Array([1, 2]),
    );
    expect(electron.clear).toHaveBeenCalled();
    const fileUrl = electron.writeBuffer.mock.calls.find(
      ([format]) => format === "public.file-url",
    )?.[1];
    expect(fileUrl?.toString()).toMatch(/^file:\/\//);
    expect(electron.writeBuffer).not.toHaveBeenCalledWith("application/pdf", Buffer.from([1, 2]));
  });

  it("downloads signed content directly before copying it", async () => {
    electron.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2])));

    await Effect.runPromise(
      downloadSnippetToClipboard({
        kind: "FILE",
        storageProvider: "DROPBOX",
        url: "https://dl.dropboxusercontent.com/signed",
        fileName: "report.pdf",
        contentType: "application/pdf",
        byteSize: 2,
      }),
    );

    expect(electron.fetch).toHaveBeenCalledWith("https://dl.dropboxusercontent.com/signed");
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("-report.pdf"),
      new Uint8Array([1, 2]),
    );
  });

  it("rejects a renderer-supplied URL outside the selected storage provider", async () => {
    const result = await Effect.runPromise(
      Effect.exit(
        downloadSnippetToClipboard({
          kind: "FILE",
          storageProvider: "DROPBOX",
          url: "https://localhost/admin",
          fileName: "report.pdf",
          contentType: "application/pdf",
          byteSize: 2,
        }),
      ),
    );

    expect(result._tag).toBe("Failure");
    expect(electron.fetch).not.toHaveBeenCalledWith("https://localhost/admin");
  });
});
