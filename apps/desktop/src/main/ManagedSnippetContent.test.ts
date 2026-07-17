import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it, vi } from "vite-plus/test";
import { Effect, Fiber, FileSystem, Layer, PlatformError, Stream } from "effect";

import {
  DesktopManagedSnippetContent,
  managedSnippetContentPath,
} from "./ManagedSnippetContent.ts";
import { uploadPreparedFile } from "../storageUpload.ts";

const accountId = "user-1";
const snippetId = "0d1e2f3a-4567-4890-8abc-def012345678";
const platformLayer = NodeFileSystem.layer;
const inputMetadata = {
  fileName: "report.docx",
  mediaType: null,
  storageProvider: "GOOGLE_DRIVE" as const,
};

const ingest = (
  root: string,
  input: Parameters<DesktopManagedSnippetContent["Service"]["ingest"]>[1],
) =>
  DesktopManagedSnippetContent.use((content) => content.ingest(accountId, input)).pipe(
    Effect.provide(DesktopManagedSnippetContent.layer(root).pipe(Layer.provide(platformLayer))),
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
            undefined,
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

  it("streams hydrated bytes into the same atomic managed-content path", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      await Effect.runPromise(
        DesktopManagedSnippetContent.use((content) =>
          content.putStream(
            accountId,
            snippetId,
            4,
            Stream.make(new Uint8Array([1, 2]), new Uint8Array([3, 4])),
          ),
        ).pipe(
          Effect.provide(
            DesktopManagedSnippetContent.layer(contentRoot).pipe(Layer.provide(platformLayer)),
          ),
        ),
      );

      await expect(
        readFile(managedSnippetContentPath(contentRoot, accountId, snippetId)),
      ).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    });
  });

  it("reconciles same-size corruption of hydrated content as unavailable", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      const layer = DesktopManagedSnippetContent.layer(contentRoot).pipe(
        Layer.provide(platformLayer),
      );
      await Effect.runPromise(
        DesktopManagedSnippetContent.use((content) =>
          content.putStream(accountId, snippetId, 4, Stream.make(new Uint8Array([1, 2, 3, 4]))),
        ).pipe(Effect.provide(layer)),
      );

      await writeFile(
        managedSnippetContentPath(contentRoot, accountId, snippetId),
        new Uint8Array([4, 3, 2, 1]),
      );

      await expect(
        Effect.runPromise(
          DesktopManagedSnippetContent.use((content) =>
            content.available(accountId, snippetId, 4),
          ).pipe(Effect.provide(layer)),
        ),
      ).resolves.toBe(false);
    });
  });

  it("rejects and cleans an incomplete hydrated stream", async () => {
    await withDirectory(async (root) => {
      const contentRoot = join(root, "content");
      await expect(
        Effect.runPromise(
          DesktopManagedSnippetContent.use((content) =>
            content.putStream(accountId, snippetId, 4, Stream.make(new Uint8Array([1, 2]))),
          ).pipe(
            Effect.provide(
              DesktopManagedSnippetContent.layer(contentRoot).pipe(Layer.provide(platformLayer)),
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
            DesktopManagedSnippetContent.use((content) =>
              content.putStream(
                accountId,
                snippetId,
                4,
                Stream.make(new Uint8Array([1, 2])).pipe(Stream.concat(Stream.fail(diskFull))),
              ),
            ).pipe(
              Effect.provide(
                DesktopManagedSnippetContent.layer(contentRoot).pipe(Layer.provide(platformLayer)),
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
          DesktopManagedSnippetContent.use((content) =>
            content.ingest(accountId, {
              ...inputMetadata,
              id: snippetId,
              byteSize: 3,
              filePath: "/cloud-only/report.docx",
            }),
          ).pipe(
            Effect.provide(
              DesktopManagedSnippetContent.layer(contentRoot).pipe(
                Layer.provide(failingFileSystem),
              ),
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
        DesktopManagedSnippetContent.use((content) =>
          content.ingest(accountId, {
            ...inputMetadata,
            id: snippetId,
            byteSize: 3,
            filePath: "/cloud-only/report.docx",
          }),
        ).pipe(
          Effect.provide(
            DesktopManagedSnippetContent.layer(contentRoot).pipe(Layer.provide(stalledFileSystem)),
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
