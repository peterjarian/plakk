import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DesktopApi } from "./index.ts";

const boundary = vi.hoisted(() => ({
  api: undefined as DesktopApi | undefined,
  invoke: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: DesktopApi) => {
      boundary.api = api;
    },
  },
  webUtils: { getPathForFile: vi.fn(() => "/tmp/source.txt") },
}));

vi.mock("../ipc/preload.ts", () => ({
  invoke: boundary.invoke,
  on: vi.fn(() => vi.fn()),
}));

await import("./index.ts");

const payload = {
  id: "08d7c9ab-7376-46ba-af55-edf4829c5834",
  fileName: "note.txt",
  byteSize: 4,
  mediaType: "text/plain",
  storageProvider: "GOOGLE_DRIVE",
  bytes: new Uint8Array([110, 111, 116, 101]),
} as const;

describe("snippet ingestion preload boundary", () => {
  beforeEach(() => boundary.invoke.mockReset());

  it("preserves explicitly authored ingest failure copy as a structured result", async () => {
    const result = { status: "FAILED", message: "Choose a local file to add." } as const;
    boundary.invoke.mockResolvedValue(result);

    await expect(boundary.api?.snippets.ingest(payload)).resolves.toEqual(result);
  });

  it("passes the invocation promise through without translating its failure channel", () => {
    const invocation = Promise.resolve({ status: "ENQUEUED" } as const);
    boundary.invoke.mockReturnValue(invocation);

    expect(boundary.api?.snippets.ingest(payload)).toBe(invocation);
  });

  it("passes an opaque native source without exposing its filesystem path", async () => {
    boundary.invoke.mockResolvedValue({ status: "ENQUEUED" });
    const { bytes: _bytes, ...fileMetadata } = payload;

    await boundary.api?.snippets.ingest({
      ...fileMetadata,
      sourceId: "opaque-source",
    });

    expect(boundary.invoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceId: "opaque-source" }),
    );
    expect(boundary.api?.tray.selectFiles).toBeTypeOf("function");
    expect(boundary.api).not.toHaveProperty("runtimeConfig");
  });
});
