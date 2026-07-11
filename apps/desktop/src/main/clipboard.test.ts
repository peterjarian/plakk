import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

const electron = vi.hoisted(() => ({
  availableFormats: vi.fn(() => [] as Array<string>),
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
    availableFormats: electron.availableFormats,
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

  it("materializes files and writes a native macOS file clipboard item", async () => {
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
    const fileList = electron.writeBuffer.mock.calls.find(
      ([format]) => format === "NSFilenamesPboardType",
    )?.[1];
    expect(fileList?.toString()).toContain("<array><string>/tmp/plakk-snippet-");
    expect(fileList?.toString()).toContain("-report.pdf</string></array>");
    expect(electron.writeBuffer).not.toHaveBeenCalledWith("application/pdf", Buffer.from([1, 2]));
  });

  it("downloads signed content directly before copying it", async () => {
    electron.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2])));

    await Effect.runPromise(
      downloadSnippetToClipboard({
        kind: "FILE",
        storageProvider: "DROPBOX",
        download: { url: "https://dl.dropboxusercontent.com/signed", headers: [] },
        fileName: "report.pdf",
        contentType: "application/pdf",
        byteSize: 2,
      }),
    );

    expect(electron.fetch).toHaveBeenCalledWith("https://dl.dropboxusercontent.com/signed", {
      headers: {},
    });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("-report.pdf"),
      new Uint8Array([1, 2]),
    );
  });

  it("downloads Google Drive media with provider authorization", async () => {
    electron.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2])));
    electron.createFromBuffer.mockReturnValue({ isEmpty: () => false });

    await Effect.runPromise(
      downloadSnippetToClipboard({
        kind: "IMAGE",
        storageProvider: "GOOGLE_DRIVE",
        download: {
          url: "https://www.googleapis.com/drive/v3/files/file-id?alt=media",
          headers: [{ name: "Authorization", value: "Bearer provider-token" }],
        },
        fileName: "photo.jpeg",
        contentType: "image/jpeg",
        byteSize: 2,
      }),
    );

    expect(electron.fetch).toHaveBeenCalledWith(
      "https://www.googleapis.com/drive/v3/files/file-id?alt=media",
      { headers: { Authorization: "Bearer provider-token" } },
    );
    expect(electron.writeImage).toHaveBeenCalled();
  });

  it("rejects a renderer-supplied URL outside the selected storage provider", async () => {
    const result = await Effect.runPromise(
      Effect.exit(
        downloadSnippetToClipboard({
          kind: "FILE",
          storageProvider: "DROPBOX",
          download: { url: "https://localhost/admin", headers: [] },
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
