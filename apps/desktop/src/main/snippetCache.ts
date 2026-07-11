import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { SnippetKind } from "@plakk/shared";

export type SnippetContent = {
  readonly bytes: Uint8Array;
  readonly kind: SnippetKind;
  readonly fileName: string;
  readonly contentType: string | null;
};

type CachedSnippetMetadata = Omit<SnippetContent, "bytes"> & { readonly byteSize: number };

export type CachedSnippetContent = SnippetContent & { readonly path: string };

const cacheRoot = () => join(app.getPath("userData"), "snippet-cache");

const cacheDirectory = (root: string, userId: string) => join(root, encodeURIComponent(userId));

const cachePath = (root: string, userId: string, snippetId: string) =>
  join(cacheDirectory(root, userId), snippetId);

const metadataPath = (path: string) => `${path}.json`;

const inferredImageContentTypes: Readonly<Record<string, string>> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

const normalizeContentType = (content: SnippetContent): string | null => {
  if (content.kind !== "IMAGE" || content.contentType?.startsWith("image/")) {
    return content.contentType;
  }
  const extension = content.fileName.split(".").pop()?.toLowerCase();
  return extension === undefined
    ? content.contentType
    : (inferredImageContentTypes[extension] ?? content.contentType);
};

const readCachedSnippet = async (path: string): Promise<CachedSnippetContent | null> => {
  try {
    const [bytes, rawMetadata] = await Promise.all([
      readFile(path),
      readFile(metadataPath(path), "utf8"),
    ]);
    const metadata = JSON.parse(rawMetadata) as CachedSnippetMetadata;
    if (
      bytes.byteLength !== metadata.byteSize ||
      (metadata.kind !== "FILE" &&
        metadata.kind !== "IMAGE" &&
        metadata.kind !== "TEXT" &&
        metadata.kind !== "LINK")
    ) {
      return null;
    }
    return { ...metadata, bytes, path };
  } catch {
    return null;
  }
};

export async function getCachedSnippetContent(input: {
  readonly userId: string;
  readonly snippetId: string;
  readonly download: () => Promise<SnippetContent>;
  readonly root?: string;
}): Promise<CachedSnippetContent> {
  const path = cachePath(input.root ?? cacheRoot(), input.userId, input.snippetId);
  const cached = await readCachedSnippet(path);
  if (cached !== null) return cached;

  await rm(path, { force: true });
  await rm(metadataPath(path), { force: true });

  const downloaded = await input.download();
  const content = { ...downloaded, contentType: normalizeContentType(downloaded) };
  const metadata: CachedSnippetMetadata = {
    kind: content.kind,
    fileName: content.fileName,
    contentType: content.contentType,
    byteSize: content.bytes.byteLength,
  };
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  const temporaryMetadataPath = `${temporaryPath}.json`;

  await mkdir(dirname(path), { recursive: true });
  try {
    await Promise.all([
      writeFile(temporaryPath, content.bytes),
      writeFile(temporaryMetadataPath, JSON.stringify(metadata)),
    ]);
    await rename(temporaryPath, path);
    await rename(temporaryMetadataPath, metadataPath(path));
  } finally {
    await Promise.all([
      rm(temporaryPath, { force: true }),
      rm(temporaryMetadataPath, { force: true }),
    ]);
  }

  return { ...content, path };
}

export async function readCachedSnippetFile(input: {
  readonly userId: string;
  readonly snippetId: string;
}): Promise<CachedSnippetContent | null> {
  return readCachedSnippet(cachePath(cacheRoot(), input.userId, input.snippetId));
}

export async function removeCachedSnippet(input: {
  readonly userId: string;
  readonly snippetId: string;
  readonly root?: string;
}): Promise<void> {
  const path = cachePath(input.root ?? cacheRoot(), input.userId, input.snippetId);
  await Promise.all([rm(path, { force: true }), rm(metadataPath(path), { force: true })]);
}

export const clearCachedSnippets = (userId: string, root = cacheRoot()): Promise<void> =>
  rm(cacheDirectory(root, userId), { recursive: true, force: true });
