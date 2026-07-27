import type { ApiSnippet, PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  WebProviderTransfer,
  WebSnippetUploadRemote,
  WebSnippetUploads,
  type WebSnippetUploadInput,
} from "./snippet-upload.ts";

const input: WebSnippetUploadInput = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "note.txt",
  mediaType: "text/plain; charset=utf-8",
  storageProvider: "GOOGLE_DRIVE",
  content: new Blob(["note"], { type: "text/plain" }),
};

const prepared: PreparedStorageUpload = {
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: null,
  upload: {
    method: "PUT",
    url: "https://www.googleapis.com/upload/drive/v3/files?upload_id=test",
    headers: [],
    strategy: { type: "single_request" },
  },
  expiresAt: null,
};

const published: ApiSnippet = {
  id: input.id,
  fileName: input.fileName,
  byteSize: input.content.size,
  storageProvider: input.storageProvider,
  storageObjectId: "drive-object",
  createdAt: "2026-07-27T10:00:00.000Z",
  updatedAt: "2026-07-27T10:00:00.000Z",
};

const makeRuntime = (options?: {
  readonly publish?: WebSnippetUploadRemote["Service"]["publish"];
  readonly transfer?: WebProviderTransfer["Service"]["upload"];
}) => {
  let uploads: WebSnippetUploads["Service"] | null = null;
  const prepare = vi.fn(() =>
    Effect.sync(() => {
      expect(uploads?.getSnapshot()).toMatchObject([
        { kind: "LOCAL", id: input.id, status: "UPLOADING" },
      ]);
      return prepared;
    }),
  );
  const publish = vi.fn(
    options?.publish ??
      (() =>
        Effect.succeed({
          ...published,
        })),
  );
  const transfer = vi.fn(
    options?.transfer ?? (() => Effect.succeed({ storageObjectId: "drive-object" })),
  );
  const layer = WebSnippetUploads.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(WebSnippetUploadRemote, WebSnippetUploadRemote.of({ prepare, publish })),
        Layer.succeed(WebProviderTransfer, WebProviderTransfer.of({ upload: transfer })),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  return {
    prepare,
    publish,
    runtime,
    transfer,
    initialize: async () => {
      uploads = await runtime.runPromise(WebSnippetUploads);
      return uploads;
    },
  };
};

describe("Web page-lifetime Snippet uploads", () => {
  it("creates one local record, transfers complete content, publishes, and promotes the same identity", async () => {
    const test = makeRuntime();
    const uploads = await test.initialize();

    await test.runtime.runPromise(uploads.upload(input));

    expect(test.prepare).toHaveBeenCalledWith({
      id: input.id,
      fileName: input.fileName,
      byteSize: 4,
      storageProvider: input.storageProvider,
      mediaType: input.mediaType,
    });
    expect(test.transfer).toHaveBeenCalledWith({ content: input.content, prepared });
    expect(test.publish).toHaveBeenCalledWith({
      id: input.id,
      fileName: input.fileName,
      byteSize: 4,
      storageProvider: input.storageProvider,
      storageObjectId: "drive-object",
    });
    expect(uploads.getSnapshot()).toEqual([{ kind: "PUBLISHED", snippet: published }]);
    await test.runtime.dispose();
  });

  it("keeps a lost publication response local until a complete snapshot promotes it", async () => {
    const test = makeRuntime({
      publish: () =>
        Effect.fail(
          new RpcError({
            code: "INTERNAL_SERVER_ERROR",
            message: "publication response was lost",
          }),
        ),
    });
    const uploads = await test.initialize();

    await test.runtime.runPromise(uploads.upload(input));
    expect(uploads.getSnapshot()).toMatchObject([
      {
        kind: "LOCAL",
        id: input.id,
        status: "FAILED",
        errorMessage: "publication response was lost",
      },
    ]);

    await test.runtime.runPromise(uploads.replacePublished([published]));
    expect(uploads.getSnapshot()).toEqual([{ kind: "PUBLISHED", snippet: published }]);
    await test.runtime.dispose();
  });

  it("keeps publication conflicts honest and dismisses only failed local work", async () => {
    const test = makeRuntime({
      publish: () =>
        Effect.fail(
          new RpcError({
            code: "CONFLICT",
            message: "Snippet identifier is already used by different content.",
          }),
        ),
    });
    const uploads = await test.initialize();

    await test.runtime.runPromise(uploads.upload(input));
    expect(uploads.getSnapshot()).toMatchObject([
      {
        kind: "LOCAL",
        status: "FAILED",
        errorMessage: "Snippet identifier is already used by different content.",
      },
    ]);
    const conflictingPublished = {
      ...published,
      storageObjectId: "different-drive-object",
    };
    await test.runtime.runPromise(uploads.replacePublished([conflictingPublished]));
    expect(uploads.getSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "LOCAL",
          status: "FAILED",
          errorMessage: "Snippet identifier is already used by different content.",
        }),
        { kind: "PUBLISHED", snippet: conflictingPublished },
      ]),
    );
    await test.runtime.runPromise(uploads.dismiss(input.id));
    expect(uploads.getSnapshot()).toEqual([{ kind: "PUBLISHED", snippet: conflictingPublished }]);
    await test.runtime.dispose();
  });

  it("marks interrupted work failed without publication or a durable resume path", async () => {
    const test = makeRuntime({ transfer: () => Effect.never });
    const uploads = await test.initialize();

    await test.runtime.runPromise(
      Effect.gen(function* () {
        const fiber = yield* uploads.upload(input).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(test.publish).not.toHaveBeenCalled();
    expect(uploads.getSnapshot()).toMatchObject([
      {
        kind: "LOCAL",
        status: "FAILED",
        errorMessage: "This upload was interrupted. Dismiss it and add the content again.",
      },
    ]);
    await test.runtime.dispose();
  });
});
