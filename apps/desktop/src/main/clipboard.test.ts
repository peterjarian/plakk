import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

const electron = vi.hoisted(() => ({
  availableFormats: vi.fn(() => [] as Array<string>),
  clear: vi.fn(),
  writeBuffer: vi.fn(),
  writeImage: vi.fn(),
  createFromBuffer: vi.fn(),
  getPath: vi.fn(() => "/tmp"),
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
}));

import { writeSnippetToClipboard } from "./clipboard.ts";

describe("stored snippet clipboard writes", () => {
  it("writes decodable images as native images", async () => {
    const image = { isEmpty: () => false };
    electron.createFromBuffer.mockReturnValue(image);

    await Effect.runPromise(
      writeSnippetToClipboard({
        bytes: new Uint8Array([1]),
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
        fileName: "photo.avif",
        contentType: "image/avif",
      }),
    );

    expect(electron.clear).toHaveBeenCalled();
    expect(electron.writeBuffer).toHaveBeenCalledWith("image/avif", Buffer.from([1, 2]));
  });

  it("materializes files and writes a native macOS file clipboard item", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    await Effect.runPromise(
      writeSnippetToClipboard({
        bytes: new Uint8Array([1, 2]),
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
    platform.mockRestore();
  });
});
