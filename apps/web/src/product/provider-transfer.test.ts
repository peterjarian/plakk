import type { PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { uploadPreparedBrowserContent } from "./provider-transfer.ts";

const prepared = (overrides: Partial<PreparedStorageUpload> = {}): PreparedStorageUpload => ({
  storageProvider: "DROPBOX",
  storageObjectId: "/snippet/note.txt",
  upload: {
    method: "POST",
    url: "https://content.dropboxapi.com/apitul/1/test",
    headers: [{ name: "Content-Type", value: "application/octet-stream" }],
    strategy: { type: "single_request" },
  },
  expiresAt: null,
  ...overrides,
});

describe("browser provider transfer", () => {
  it("sends the complete Blob only to a supported provider HTTPS target", async () => {
    const uploadFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const content = new Blob(["hello"]);

    await expect(
      Effect.runPromise(
        uploadPreparedBrowserContent({ content, prepared: prepared() }, uploadFetch),
      ),
    ).resolves.toEqual({ storageObjectId: "/snippet/note.txt" });

    expect(uploadFetch).toHaveBeenCalledWith(
      "https://content.dropboxapi.com/apitul/1/test",
      expect.objectContaining({
        body: content,
        method: "POST",
      }),
    );
  });

  it("rejects provider mismatch and unsupported origins before fetch", async () => {
    const uploadFetch = vi.fn<typeof fetch>();

    await expect(
      Effect.runPromise(
        uploadPreparedBrowserContent(
          {
            content: new Blob(["hello"]),
            prepared: prepared({
              storageProvider: "GOOGLE_DRIVE",
              upload: {
                method: "PUT",
                url: "https://www.googleapis.com.evil.example/upload",
                headers: [],
                strategy: { type: "single_request" },
              },
            }),
          },
          uploadFetch,
        ),
      ),
    ).rejects.toMatchObject({ _tag: "WebProviderTransferError" });
    expect(uploadFetch).not.toHaveBeenCalled();
  });

  it.each([202, 308])(
    "does not publish a single-request upload after non-final status %s",
    async (status) => {
      const uploadFetch = vi.fn(() => Promise.resolve(new Response(null, { status })));

      await expect(
        Effect.runPromise(
          uploadPreparedBrowserContent(
            { content: new Blob(["hello"]), prepared: prepared() },
            uploadFetch,
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "WebProviderTransferError",
        message: "The upload provider did not confirm completion.",
      });
    },
  );

  it("uploads byte ranges sequentially and uses the provider's returned object identity", async () => {
    const uploadFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ nextExpectedRanges: ["4-"] }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: "one-drive-object" }, { status: 201 }));
    const content = new Blob(["abcdefgh"]);
    const oneDrive: PreparedStorageUpload = {
      storageProvider: "ONE_DRIVE",
      storageObjectId: null,
      upload: {
        method: "PUT",
        url: "https://sn3302.up.1drv.com/up/test",
        headers: [],
        strategy: {
          type: "byte_range",
          maxPartByteSize: 4,
          partByteMultiple: 4,
        },
      },
      expiresAt: "2026-07-27T11:00:00.000Z",
    };

    await expect(
      Effect.runPromise(uploadPreparedBrowserContent({ content, prepared: oneDrive }, uploadFetch)),
    ).resolves.toEqual({ storageObjectId: "one-drive-object" });

    expect(uploadFetch).toHaveBeenNthCalledWith(
      1,
      oneDrive.upload.url,
      expect.objectContaining({
        headers: { "Content-Range": "bytes 0-3/8" },
      }),
    );
    expect(uploadFetch).toHaveBeenNthCalledWith(
      2,
      oneDrive.upload.url,
      expect.objectContaining({
        headers: { "Content-Range": "bytes 4-7/8" },
      }),
    );
  });
});
