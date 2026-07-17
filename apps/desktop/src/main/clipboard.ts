import { statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, clipboard, nativeImage } from "electron";
import { Data, Effect } from "effect";
import { deriveSnippetPresentation } from "@plakk/shared";

type SnippetContent = {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly contentType: string | null;
};

export class ReadClipboardError extends Data.TaggedError("ReadClipboardError")<{
  readonly cause: unknown;
}> {}

export class WriteClipboardError extends Data.TaggedError("WriteClipboardError")<{
  readonly cause: unknown;
}> {}

const temporaryClipboardFiles = new Set<string>();

export const consumeTemporaryClipboardFile = (path: string) => temporaryClipboardFiles.delete(path);

export type WritableClipboardContent =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image";
      readonly dataUrl: string;
    };

type ClipboardContent =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image";
      readonly dataUrl: string;
      readonly path: string;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: "file";
      readonly name: string;
      readonly path: string;
      readonly extension: string;
      readonly size?: number;
    }
  | {
      readonly type: "empty";
    };

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function encodeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function fileContentFromPath(path: string): ClipboardContent | undefined {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return undefined;

  const content: ClipboardContent = {
    type: "file",
    name: basename(path),
    path,
    extension: extname(path).slice(1).toUpperCase(),
  };

  if (stats.isFile()) return { ...content, size: stats.size };

  return content;
}

function textContent(text: string): ClipboardContent {
  return {
    type: "text",
    text,
  };
}

function emptyContent(): ClipboardContent {
  return { type: "empty" };
}

function firstFileUriPath(value: string): string {
  const uri = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("file://"));

  return uri === undefined ? "" : fileURLToPath(uri);
}

function firstMacClipboardFilePath(formats: ReadonlyArray<string>): string {
  if (formats.includes("public.file-url")) {
    const fileUrl = clipboard.read("public.file-url");
    if (fileUrl.startsWith("file://")) return fileURLToPath(fileUrl);
  }

  if (formats.includes("NSFilenamesPboardType")) {
    const fileNames = clipboard.read("NSFilenamesPboardType");
    const plistMatch = /<string>([^<]+)<\/string>/.exec(fileNames);
    if (plistMatch !== null) return decodeXmlText(plistMatch[1]);
  }

  const clipboardInfo = execFileSync("/usr/bin/osascript", ["-e", "clipboard info"], {
    encoding: "utf8",
    timeout: 1000,
  });
  if (!clipboardInfo.includes("«class furl»")) return "";

  const finderFilePath = execFileSync(
    "/usr/bin/osascript",
    [
      "-e",
      "try",
      "-e",
      "POSIX path of (the clipboard as «class furl»)",
      "-e",
      "on error",
      "-e",
      '""',
      "-e",
      "end try",
    ],
    { encoding: "utf8", timeout: 1000 },
  ).trim();

  return finderFilePath;
}

function firstWindowsClipboardFilePath(formats: ReadonlyArray<string>): string {
  if (formats.includes("FileNameW")) return clipboard.read("FileNameW").replaceAll("\u0000", "");
  if (formats.includes("CF_HDROP")) return clipboard.read("CF_HDROP").replaceAll("\u0000", "");
  return "";
}

function firstLinuxClipboardFilePath(formats: ReadonlyArray<string>): string {
  if (formats.includes("x-special/gnome-copied-files")) {
    return firstFileUriPath(clipboard.read("x-special/gnome-copied-files"));
  }
  if (formats.includes("text/uri-list")) return firstFileUriPath(clipboard.read("text/uri-list"));
  return "";
}

export const readClipboard = Effect.fn("readClipboard")(function* () {
  const file = yield* Effect.try({
    try: (): ClipboardContent | undefined => {
      const formats = clipboard.availableFormats();
      const rawPath =
        process.platform === "darwin"
          ? firstMacClipboardFilePath(formats)
          : process.platform === "win32"
            ? firstWindowsClipboardFilePath(formats)
            : firstLinuxClipboardFilePath(formats);
      if (!rawPath) return undefined;

      const path = rawPath.startsWith("file://") ? fileURLToPath(rawPath) : rawPath;
      return fileContentFromPath(path);
    },
    catch: (cause) => new ReadClipboardError({ cause }),
  });

  if (file !== undefined) return file;

  const image = yield* Effect.try({
    try: () => clipboard.readImage(),
    catch: (cause) => new ReadClipboardError({ cause }),
  });

  if (!image.isEmpty()) {
    return yield* Effect.try({
      try: (): ClipboardContent => {
        const { width, height } = image.getSize();
        const path = join(app.getPath("temp"), `plakk-clipboard-${crypto.randomUUID()}.png`);
        writeFileSync(path, image.toPNG());
        temporaryClipboardFiles.add(path);
        return { type: "image", dataUrl: image.toDataURL(), path, width, height };
      },
      catch: (cause) => new ReadClipboardError({ cause }),
    });
  }

  const text = yield* Effect.try({
    try: () => clipboard.readText().trim(),
    catch: (cause) => new ReadClipboardError({ cause }),
  });

  return text ? textContent(text) : emptyContent();
});

export const writeClipboard = Effect.fn("writeClipboard")(function* (
  content: WritableClipboardContent,
) {
  if (content.type === "text") {
    return yield* Effect.try({
      try: () => clipboard.writeText(content.text),
      catch: (cause) => new WriteClipboardError({ cause }),
    });
  }

  return yield* Effect.try({
    try: () => clipboard.writeImage(nativeImage.createFromDataURL(content.dataUrl)),
    catch: (cause) => new WriteClipboardError({ cause }),
  });
});

const clipboardFormatFor = (contentType: string | null) => {
  const format = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return format !== undefined && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(format)
    ? format
    : "application/octet-stream";
};

const writeSnippetBytes = (content: SnippetContent) => {
  clipboard.clear();
  clipboard.writeBuffer(clipboardFormatFor(content.contentType), Buffer.from(content.bytes));
};

const windowsFileDrop = (path: string) => {
  const pathBytes = Buffer.from(`${path}\u0000\u0000`, "utf16le");
  const header = Buffer.alloc(20);
  header.writeUInt32LE(20, 0);
  header.writeUInt32LE(1, 16);
  return Buffer.concat([header, pathBytes]);
};

const writeSnippetFile = (content: SnippetContent) => {
  const fileName = basename(content.fileName);
  const path = join(app.getPath("temp"), `plakk-snippet-${crypto.randomUUID()}-${fileName}`);
  const url = pathToFileURL(path).toString();

  writeFileSync(path, content.bytes);
  clipboard.clear();
  if (process.platform === "darwin") {
    clipboard.writeBuffer(
      "NSFilenamesPboardType",
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><array><string>${encodeXmlText(path)}</string></array></plist>`,
      ),
    );
  } else if (process.platform === "linux") {
    clipboard.writeBuffer("x-special/gnome-copied-files", Buffer.from(`copy\n${url}`));
    clipboard.writeBuffer("text/uri-list", Buffer.from(url));
  } else {
    clipboard.writeBuffer("CF_HDROP", windowsFileDrop(path));
  }
};

export const writeSnippetToClipboard = Effect.fn("writeSnippetToClipboard")(function* (
  content: SnippetContent,
) {
  return yield* Effect.try({
    try: () => {
      const presentation = deriveSnippetPresentation({
        fileName: content.fileName,
        content: content.bytes,
      });
      if (presentation.type === "image") {
        const image = nativeImage.createFromBuffer(Buffer.from(content.bytes));
        if (image.isEmpty()) writeSnippetBytes(content);
        else clipboard.writeImage(image);
        return;
      }

      writeSnippetFile(content);
    },
    catch: (cause) => new WriteClipboardError({ cause }),
  });
});
