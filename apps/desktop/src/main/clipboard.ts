import { statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, clipboard, nativeImage } from "electron";
import { Data, Effect } from "effect";

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
