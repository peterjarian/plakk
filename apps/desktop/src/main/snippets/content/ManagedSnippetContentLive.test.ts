import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it, vi } from "vite-plus/test";
import { Effect, Fiber, FileSystem, Layer, Option, PlatformError, Stream } from "effect";

import { ManagedSnippetContent } from "./ManagedSnippetContent.ts";
import {
  managedSnippetContentPath,
  makeManagedSnippetContentLive,
} from "./ManagedSnippetContentLive.ts";
import { uploadPreparedFile } from "../upload/StorageUploadLive.ts";

const accountId = "user-1";
const snippetId = "0d1e2f3a-4567-4890-8abc-def012345678";
const platformLayer = NodeFileSystem.layer;
const inputMetadata = {
  fileName: "report.docx",
  mediaType: null,
  storageProvider: "GOOGLE_DRIVE" as const,
};

const ingest = (root: string, input: Parameters<ManagedSnippetContent["Service"]["ingest"]>[1]) =>
  ManagedSnippetContent.use((content) => content.ingest(accountId, input)).pipe(
    Effect.provide(makeManagedSnippetContentLive(root).pipe(Layer.provide(platformLayer))),
  );

const withDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "plakk-managed-content-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("managed snippet content ingestion", () => {
  it("derives usage from managed files and removes only content outside the retained set", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const retainedId = snippetId;
      const removedId = "1d1e2f3a-4567-4890-8abc-def012345679";
      const layer = makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(platformLayer));

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const content = yield* ManagedSnippetContent;
          yield* content.ingest(accountId, {
            ...inputMetadata,
            id: retainedId,
            byteSize: 3,
            bytes: new Uint8Array([1, 2, 3]),
          });
          yield* content.ingest(accountId, {
            ...inputMetadata,
            id: removedId,
            byteSize: 2,
            bytes: new Uint8Array([4, 5]),
          });
          const before = yield* content.storageUsageBytes(accountId);
          const reclamation = yield* content.removeExcept(accountId, new Set([retainedId]));
          return {
            before,
            reclamation,
            after: yield* content.storageUsageBytes(accountId),
          };
        }).pipe(Effect.provide(layer)),
      );

      expect(result).toEqual({
        before: 5,
        reclamation: { reclaimedBytes: 2, removedCopies: 1 },
        after: 3,
      });
      await expect(
        readFile(managedSnippetContentPath(contentRoot, accountId, retainedId)),
      ).resolves.toEqual(Buffer.from([1, 2, 3]));
      await expect(
        readFile(managedSnippetContentPath(contentRoot, accountId, removedId)),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("distinguishes removing a zero-byte managed copy from a no-op", async () => {
    await withDirectory(async (root) => {
      const layer = makeManagedSnippetContentLive(join(root, "content")).pipe(
        Layer.provide(platformLayer),
      );

      const reclamation = await Effect.runPromise(
        Effect.gen(function* () {
          const content = yield* ManagedSnippetContent;
          yield* content.ingest(accountId, {
            ...inputMetadata,
            id: snippetId,
            byteSize: 0,
            bytes: new Uint8Array(),
          });
          return yield* content.removeExcept(accountId, new Set());
        }).pipe(Effect.provide(layer)),
      );

      expect(reclamation).toEqual({ reclaimedBytes: 0, removedCopies: 1 });
    });
  });

  it("publishes the owning account after managed bytes become available", async () => {
    await withDirectory(async (root) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const content = yield* ManagedSnippetContent;
            const changed = yield* content.changes.pipe(Stream.runHead, Effect.forkChild);
            yield* Effect.yieldNow;
            yield* content.ingest(accountId, {
              ...inputMetadata,
              id: snippetId,
              byteSize: 3,
              bytes: new Uint8Array([1, 2, 3]),
            });
            return Option.getOrNull(yield* Fiber.join(changed));
          }),
        ).pipe(
          Effect.provide(makeManagedSnippetContentLive(join(root, "content"))),
          Effect.provide(platformLayer),
        ),
      );

      expect(result).toBe(accountId);
    });
  });

  it("uploads from the managed copy after the original is removed", async () => {
    await withDirectory(async (root) => {
      const original = join(root, "cloud-source.docx");
      const contentRoot = join(root, "content");
      await writeFile(original, new Uint8Array([1, 2, 3]));

      const managedPath = await Effect.runPromise(
        ingest(contentRoot, {
          ...inputMetadata,
          id: snippetId,
          byteSize: 3,
          filePath: original,
        }).pipe(Effect.provide(platformLayer)),
      );
      await unlink(original);
      await expect(
        Effect.runPromise(
          ingest(contentRoot, {
            ...inputMetadata,
            id: snippetId,
            byteSize: 3,
            filePath: original,
          }).pipe(Effect.provide(platformLayer)),
        ),
      ).resolves.toBe(managedPath);

      const uploadFetch = vi.fn(async (_input: string, init?: RequestInit) => {
        const body = init?.body;
        if (!(body instanceof Blob)) throw new Error("Expected an upload body.");
        expect(new Uint8Array(await body.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        return new Response(null);
      });
      await expect(
        Effect.runPromise(
          uploadPreparedFile(
            {
              id: snippetId,
              byteSize: 3,
              filePath: managedPath,
              prepared: {
                storageProvider: "DROPBOX",
                storageObjectId: "/snippet/report.docx",
                upload: {
                  method: "POST",
                  url: "https://upload.example/dropbox",
                  headers: [],
                  strategy: { type: "single_request" },
                },
                expiresAt: null,
              },
            },
            uploadFetch,
          ).pipe(Effect.provide(platformLayer)),
        ),
      ).resolves.toEqual({ storageObjectId: "/snippet/report.docx" });

      expect(managedPath).toBe(managedSnippetContentPath(contentRoot, accountId, snippetId));
      await expect(readFile(managedPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    });
  });

  it("uses the same managed path for encoded bytes", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const managedPath = await Effect.runPromise(
        ingest(contentRoot, {
          ...inputMetadata,
          id: snippetId,
          byteSize: 3,
          bytes: new Uint8Array([4, 5, 6]),
        }).pipe(Effect.provide(platformLayer)),
      );

      expect(managedPath).toBe(managedSnippetContentPath(contentRoot, accountId, snippetId));
      await expect(readFile(managedPath)).resolves.toEqual(Buffer.from([4, 5, 6]));
    });
  });

  it("invalidates same-size corruption of origin-upload content", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const layer = makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(platformLayer));

      const available = await Effect.runPromise(
        Effect.gen(function* () {
          const content = yield* ManagedSnippetContent;
          const path = yield* content.ingest(accountId, {
            ...inputMetadata,
            id: snippetId,
            byteSize: 3,
            bytes: new Uint8Array([1, 2, 3]),
          });
          yield* Effect.promise(() => writeFile(path, new Uint8Array([3, 2, 1])));
          return yield* content.available(accountId, snippetId, 3);
        }).pipe(Effect.provide(layer)),
      );

      expect(available).toBe(false);
    });
  });

  it("streams hydrated bytes into the same atomic managed-content path", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      await Effect.runPromise(
        ManagedSnippetContent.use((content) =>
          content.putStream(
            accountId,
            snippetId,
            4,
            Stream.make(new Uint8Array([1, 2]), new Uint8Array([3, 4])),
          ),
        ).pipe(
          Effect.provide(
            makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(platformLayer)),
          ),
        ),
      );

      await expect(
        readFile(managedSnippetContentPath(contentRoot, accountId, snippetId)),
      ).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    });
  });

  it("reads only the requested managed-content prefix for presentation", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const bytes = new Uint8Array(128 * 1024).map((_, index) => index % 251);
      const layer = makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(platformLayer));

      const preview = await Effect.runPromise(
        ManagedSnippetContent.use((content) =>
          Effect.gen(function* () {
            yield* content.putStream(accountId, snippetId, bytes.byteLength, Stream.succeed(bytes));
            return yield* content.getPrefix(accountId, snippetId, 4096);
          }),
        ).pipe(Effect.provide(layer)),
      );

      expect(preview === null ? null : Uint8Array.from(preview)).toEqual(bytes.slice(0, 4096));
    });
  });

  it("verifies hydrated integrity once and keeps later availability checks cheap", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const contentPath = managedSnippetContentPath(contentRoot, accountId, snippetId);
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await mkdir(dirname(contentPath), { recursive: true });
      await writeFile(contentPath, bytes);
      await writeFile(
        join(dirname(contentPath), "content.sha256"),
        createHash("sha256").update(bytes).digest("hex"),
      );

      const fileSystem = await Effect.runPromise(
        FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
      );
      const stream = vi.fn(fileSystem.stream);
      const countingFileSystem = Layer.succeed(FileSystem.FileSystem, {
        ...fileSystem,
        stream,
      });
      const layer = makeManagedSnippetContentLive(contentRoot).pipe(
        Layer.provide(countingFileSystem),
      );

      const availability = await Effect.runPromise(
        ManagedSnippetContent.use((content) =>
          Effect.gen(function* () {
            const first = yield* content.available(accountId, snippetId, bytes.byteLength);
            const second = yield* content.available(accountId, snippetId, bytes.byteLength);
            return [first, second];
          }),
        ).pipe(Effect.provide(layer)),
      );

      expect(availability).toEqual([true, true]);
      expect(stream).toHaveBeenCalledTimes(1);
    });
  });

  it("reconciles same-size corruption of hydrated content as unavailable", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const layer = makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(platformLayer));
      await Effect.runPromise(
        ManagedSnippetContent.use((content) =>
          content.putStream(accountId, snippetId, 4, Stream.make(new Uint8Array([1, 2, 3, 4]))),
        ).pipe(Effect.provide(layer)),
      );

      await writeFile(
        managedSnippetContentPath(contentRoot, accountId, snippetId),
        new Uint8Array([4, 3, 2, 1]),
      );

      await expect(
        Effect.runPromise(
          ManagedSnippetContent.use((content) => content.available(accountId, snippetId, 4)).pipe(
            Effect.provide(layer),
          ),
        ),
      ).resolves.toBe(false);
    });
  });

  it("rechecks integrity when a verified file changes during the same runtime", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const contentPath = managedSnippetContentPath(contentRoot, accountId, snippetId);
      const layer = makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(platformLayer));

      const availability = await Effect.runPromise(
        ManagedSnippetContent.use((content) =>
          Effect.gen(function* () {
            yield* content.putStream(
              accountId,
              snippetId,
              4,
              Stream.make(new Uint8Array([1, 2, 3, 4])),
            );
            const before = yield* content.available(accountId, snippetId, 4);
            yield* Effect.promise(() => writeFile(contentPath, new Uint8Array([4, 3, 2, 1])));
            const changedAt = new Date(Date.now() + 1_000);
            yield* Effect.promise(() => utimes(contentPath, changedAt, changedAt));
            const after = yield* content.available(accountId, snippetId, 4);
            return [before, after];
          }),
        ).pipe(Effect.provide(layer)),
      );

      expect(availability).toEqual([true, false]);
    });
  });

  it("validates UTF-8 beyond the bounded presentation prefix", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const bytes = new Uint8Array(64 * 1024 + 1).fill(0x61);
      bytes[bytes.byteLength - 1] = 0xff;
      const layer = makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(platformLayer));

      const validation = await Effect.runPromise(
        ManagedSnippetContent.use((content) =>
          Effect.gen(function* () {
            yield* content.putStream(accountId, snippetId, bytes.byteLength, Stream.make(bytes));
            return yield* content.validateText(accountId, snippetId);
          }),
        ).pipe(Effect.provide(layer)),
      );

      expect(validation).toBe("INVALID");
    });
  });

  it("stops reading managed text after the first invalid UTF-8 chunk", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const contentPath = managedSnippetContentPath(contentRoot, accountId, snippetId);
      await mkdir(dirname(contentPath), { recursive: true });
      await writeFile(contentPath, new Uint8Array([0xff, 0x61]));

      const fileSystem = await Effect.runPromise(
        FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
      );
      let laterChunksRead = 0;
      const countingFileSystem = Layer.succeed(FileSystem.FileSystem, {
        ...fileSystem,
        stream: (path, options) =>
          path === contentPath && options === undefined
            ? Stream.make(new Uint8Array([0xff])).pipe(
                Stream.concat(
                  Stream.fromEffect(
                    Effect.sync(() => {
                      laterChunksRead += 1;
                      return new Uint8Array([0x61]);
                    }),
                  ),
                ),
              )
            : fileSystem.stream(path, options),
      });

      const validation = await Effect.runPromise(
        ManagedSnippetContent.use((content) => content.validateText(accountId, snippetId)).pipe(
          Effect.provide(
            makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(countingFileSystem)),
          ),
        ),
      );

      expect(validation).toBe("INVALID");
      expect(laterChunksRead).toBe(0);
    });
  });

  it("replaces same-size corrupt hydrated content", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const contentPath = managedSnippetContentPath(contentRoot, accountId, snippetId);
      const expected = new Uint8Array([1, 2, 3, 4]);
      await mkdir(dirname(contentPath), { recursive: true });
      await writeFile(contentPath, new Uint8Array([4, 3, 2, 1]));
      await writeFile(
        join(dirname(contentPath), "content.sha256"),
        createHash("sha256").update(expected).digest("hex"),
      );

      const layer = makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(platformLayer));
      const result = await Effect.runPromise(
        ManagedSnippetContent.use((content) =>
          Effect.gen(function* () {
            const before = yield* content.available(accountId, snippetId, expected.byteLength);
            yield* content.putStream(
              accountId,
              snippetId,
              expected.byteLength,
              Stream.succeed(expected),
            );
            const after = yield* content.available(accountId, snippetId, expected.byteLength);
            const bytes = yield* content.get(accountId, snippetId);
            return { after, before, bytes };
          }),
        ).pipe(Effect.provide(layer)),
      );

      expect(result.before).toBe(false);
      expect(result.after).toBe(true);
      expect(result.bytes === null ? null : Uint8Array.from(result.bytes)).toEqual(expected);
    });
  });

  it("rejects and cleans an incomplete hydrated stream", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      await expect(
        Effect.runPromise(
          ManagedSnippetContent.use((content) =>
            content.putStream(accountId, snippetId, 4, Stream.make(new Uint8Array([1, 2]))),
          ).pipe(
            Effect.provide(
              makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(platformLayer)),
            ),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "ManagedSnippetContentError",
        reason: "Hydrated content does not match its metadata.",
      });

      const accountDirectory = join(contentRoot, Buffer.from(accountId).toString("base64url"));
      await expect(readdir(accountDirectory, { recursive: true })).resolves.toEqual([]);
    });
  });

  it.each(["ENOSPC", "EDQUOT"] as const)(
    "reports local storage exhaustion (%s) during hydration and removes partial content",
    async (code) => {
      await withDirectory(async (root) => {
        const contentRoot = join(root, "content");
        const diskFull = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "write",
          cause: Object.assign(new Error("local storage exhausted"), { code }),
        });

        await expect(
          Effect.runPromise(
            ManagedSnippetContent.use((content) =>
              content.putStream(
                accountId,
                snippetId,
                4,
                Stream.make(new Uint8Array([1, 2])).pipe(Stream.concat(Stream.fail(diskFull))),
              ),
            ).pipe(
              Effect.provide(
                makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(platformLayer)),
              ),
            ),
          ),
        ).rejects.toMatchObject({
          _tag: "ManagedSnippetContentError",
          reason:
            "There isn’t enough space on this Mac to save this file. Free some space, then try again.",
        });

        const accountDirectory = join(contentRoot, Buffer.from(accountId).toString("base64url"));
        await expect(readdir(accountDirectory, { recursive: true })).resolves.toEqual([]);
      });
    },
  );

  it.each([
    {
      name: "File Provider timeout",
      error: PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "copyFile",
        cause: Object.assign(new Error("connection timed out, read"), {
          code: "ETIMEDOUT",
        }),
      }),
      reason:
        "This file isn’t available on this Mac yet. Check its cloud download, then try again.",
    },
    {
      name: "insufficient local storage",
      error: PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "copyFile",
        cause: Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
      }),
      reason:
        "There isn’t enough space on this Mac to save this file. Free some space, then try again.",
    },
    {
      name: "missing source file",
      error: PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "copyFile",
      }),
      reason: "This file is no longer available. Choose it again.",
    },
    {
      name: "unreadable source file",
      error: PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "copyFile",
      }),
      reason: "Plakk can’t read this file. Check its permissions, then choose it again.",
    },
    {
      name: "an unclassified filesystem failure",
      error: PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "copyFile",
        cause: Object.assign(new Error("input/output error"), { code: "EIO" }),
      }),
      reason:
        "Plakk couldn’t save this file locally. Make sure it is available on this Mac, then try again.",
    },
  ])("maps $name and removes partial managed content", async ({ error, reason }) => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const fileSystem = await Effect.runPromise(
        FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
      );
      const failingFileSystem = Layer.succeed(FileSystem.FileSystem, {
        ...fileSystem,
        copyFile: () => Effect.fail(error),
      });

      await expect(
        Effect.runPromise(
          ManagedSnippetContent.use((content) =>
            content.ingest(accountId, {
              ...inputMetadata,
              id: snippetId,
              byteSize: 3,
              filePath: "/cloud-only/report.docx",
            }),
          ).pipe(
            Effect.provide(
              makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(failingFileSystem)),
            ),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "ManagedSnippetContentError",
        reason,
      });

      const accountDirectory = join(contentRoot, Buffer.from(accountId).toString("base64url"));
      await expect(readdir(accountDirectory, { recursive: true })).resolves.toEqual([]);
    });
  });

  it("removes partial managed content when import is cancelled", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const fileSystem = await Effect.runPromise(
        FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
      );
      const stalledFileSystem = Layer.succeed(FileSystem.FileSystem, {
        ...fileSystem,
        copyFile: () => Effect.never,
      });
      const fiber = Effect.runFork(
        ManagedSnippetContent.use((content) =>
          content.ingest(accountId, {
            ...inputMetadata,
            id: snippetId,
            byteSize: 3,
            filePath: "/cloud-only/report.docx",
          }),
        ).pipe(
          Effect.provide(
            makeManagedSnippetContentLive(contentRoot).pipe(Layer.provide(stalledFileSystem)),
          ),
        ),
      );
      const accountDirectory = join(contentRoot, Buffer.from(accountId).toString("base64url"));
      await vi.waitFor(async () =>
        expect(await readdir(accountDirectory, { recursive: true })).not.toEqual([]),
      );

      await Effect.runPromise(Fiber.interrupt(fiber));

      await expect(readdir(accountDirectory, { recursive: true })).resolves.toEqual([]);
    });
  });
});
