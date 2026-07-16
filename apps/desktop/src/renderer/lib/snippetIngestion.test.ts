import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ingestFileSnippet, ingestTextSnippet } from "./snippetIngestion.ts";

describe("desktop snippet ingestion commands", () => {
  const ingest = vi.fn().mockResolvedValue({ status: "ENQUEUED" as const });
  const randomUUID = vi.fn();

  beforeEach(() => {
    ingest.mockClear();
    randomUUID.mockReset();
    vi.stubGlobal("crypto", { randomUUID });
    vi.stubGlobal("window", { ipc: { snippets: { ingest } } });
  });

  it("preserves non-empty text bytes and ingests them under a generated text filename", async () => {
    randomUUID.mockReturnValue("8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0");
    const text = "  hello 👋  ";

    await expect(ingestTextSnippet("GOOGLE_DRIVE", text)).resolves.toEqual({
      status: "ENQUEUED",
    });

    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledWith({
      id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
      fileName: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0.txt",
      byteSize: new TextEncoder().encode(text).byteLength,
      mediaType: "text/plain; charset=utf-8",
      storageProvider: "GOOGLE_DRIVE",
      bytes: new TextEncoder().encode(text),
    });
  });

  it("does not generate an ID or invoke IPC for an empty string", () => {
    expect(ingestTextSnippet("GOOGLE_DRIVE", "")).toBeNull();
    expect(randomUUID).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("encodes whitespace when the caller passes it as content", async () => {
    randomUUID.mockReturnValue("1f98ddf8-74cb-4d31-bf37-2ba15768de96");
    const text = " \n\t ";

    await ingestTextSnippet("GOOGLE_DRIVE", text);

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        byteSize: new TextEncoder().encode(text).byteLength,
        bytes: new TextEncoder().encode(text),
      }),
    );
  });

  it("ingests a file path with generated identity and file metadata", async () => {
    randomUUID.mockReturnValue("2dfde965-60b3-46a6-8bc0-c871221c8f25");

    await expect(
      ingestFileSnippet(
        "ONE_DRIVE",
        { name: "report.pdf", size: 42_000, type: "application/pdf" },
        "/tmp/report.pdf",
      ),
    ).resolves.toEqual({ status: "ENQUEUED" });

    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledWith({
      id: "2dfde965-60b3-46a6-8bc0-c871221c8f25",
      fileName: "report.pdf",
      byteSize: 42_000,
      mediaType: "application/pdf",
      storageProvider: "ONE_DRIVE",
      filePath: "/tmp/report.pdf",
    });
  });

  it("forwards a renderer file when no native path is available", async () => {
    randomUUID.mockReturnValue("fa2a21ca-2f18-42d8-a943-c61b5107e9b7");
    const file = { name: "photo.png", size: 1_024, type: "image/png" };

    await ingestFileSnippet("DROPBOX", file);

    expect(ingest).toHaveBeenCalledWith({
      id: "fa2a21ca-2f18-42d8-a943-c61b5107e9b7",
      fileName: "photo.png",
      byteSize: 1_024,
      mediaType: "image/png",
      storageProvider: "DROPBOX",
      file,
    });
  });
});
