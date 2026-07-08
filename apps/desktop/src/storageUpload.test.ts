import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeByteRanges, uploadPartByteSize, uploadPreparedFile } from "./storageUpload.ts";

const fetchMock = vi.fn<typeof fetch>();

async function makeUploadFile(bytes: ReadonlyArray<number>) {
  const dir = await mkdtemp(join(tmpdir(), "plakk-upload-test-"));
  const filePath = join(dir, "file.txt");
  await writeFile(filePath, new Uint8Array(bytes));
  return filePath;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("storageUpload", () => {
  it("splits byte range uploads using the backend strategy", () => {
    expect(makeByteRanges(10, 4)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 9 },
    ]);
    expect(uploadPartByteSize(10, 4)).toBe(8);
  });

  it("uploads single request files to the prepared provider URL", async () => {
    const filePath = await makeUploadFile([1, 2, 3]);

    await uploadPreparedFile({
      byteSize: 3,
      filePath,
      prepared: {
        storageProvider: "GOOGLE_DRIVE",
        storageObjectId: null,
        upload: {
          method: "PUT",
          url: "https://upload.example/file",
          headers: [{ name: "Content-Type", value: "text/plain" }],
          strategy: { type: "single_request" },
        },
        expiresAt: null,
      },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://upload.example/file");
    expect(init).toMatchObject({
      method: "PUT",
      headers: { "Content-Length": "3", "Content-Type": "text/plain" },
    });
    expect(init?.body).toBeDefined();
  });

  it("uploads byte-range files with Content-Range headers", async () => {
    const filePath = await makeUploadFile([1, 2, 3]);

    await uploadPreparedFile({
      byteSize: 3,
      filePath,
      prepared: {
        storageProvider: "ONE_DRIVE",
        storageObjectId: null,
        upload: {
          method: "PUT",
          url: "https://upload.example/session",
          headers: [],
          strategy: { type: "byte_range", maxPartByteSize: 2, partByteMultiple: 1 },
        },
        expiresAt: null,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { "Content-Length": "2", "Content-Range": "bytes 0-1/3" },
      { "Content-Length": "1", "Content-Range": "bytes 2-2/3" },
    ]);
  });
});
