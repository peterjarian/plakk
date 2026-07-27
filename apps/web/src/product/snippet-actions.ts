import {
  decodeSnippetText,
  deriveSnippetPresentation,
  isHttpUrl,
  isTextSnippetFileName,
  isTrustedStorageDownloadUrl,
} from "@plakk/shared";
import {
  WEB_SNIPPET_CONTENT_MAX_BYTES,
  type ApiSnippet,
  type PreparedSnippetDownload,
  type SnippetContent,
} from "@plakk/shared/PlakkApi";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import type { AccountProductReadError } from "./product-reader.ts";

export class WebSnippetActionError extends Data.TaggedError("WebSnippetActionError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class WebSnippetBrowserError extends Data.TaggedError("WebSnippetBrowserError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class WebSnippetActionRemote extends Context.Service<
  WebSnippetActionRemote,
  {
    readonly delete: (id: string) => Effect.Effect<void, AccountProductReadError>;
    readonly prepareDownload: (
      id: string,
    ) => Effect.Effect<PreparedSnippetDownload, AccountProductReadError>;
    readonly read: (id: string) => Effect.Effect<SnippetContent, AccountProductReadError>;
  }
>()("@plakk/web/product/snippet-actions/WebSnippetActionRemote") {}

export class WebSnippetActionBrowser extends Context.Service<
  WebSnippetActionBrowser,
  {
    readonly copyImage: (
      content: Promise<Uint8Array>,
      fileName: string,
    ) => Effect.Effect<"COPIED" | "UNSUPPORTED", WebSnippetBrowserError>;
    readonly copyText: (text: Promise<string>) => Effect.Effect<void, WebSnippetBrowserError>;
    readonly download: (
      content: Uint8Array,
      fileName: string,
    ) => Effect.Effect<void, WebSnippetBrowserError>;
    readonly downloadUrl: (
      url: string,
      fileName: string,
    ) => Effect.Effect<void, WebSnippetBrowserError>;
    readonly open: (url: string) => Effect.Effect<void, WebSnippetBrowserError>;
  }
>()("@plakk/web/product/snippet-actions/WebSnippetActionBrowser") {}

export type WebSnippetCopyOutcome =
  | { readonly kind: "COPIED" }
  | { readonly kind: "DOWNLOADED_IMAGE_FALLBACK" }
  | { readonly kind: "DOWNLOADED_FILE_FALLBACK" };

export type WebSnippetActionFailure = AccountProductReadError | WebSnippetActionError;

const actionError = (cause: unknown, message: string): WebSnippetActionError =>
  new WebSnippetActionError({ cause, message });

const browserActionError = (cause: WebSnippetBrowserError): WebSnippetActionError =>
  actionError(cause, cause.message);

export class WebSnippetActions extends Context.Service<
  WebSnippetActions,
  {
    readonly copy: (
      snippet: ApiSnippet,
    ) => Effect.Effect<WebSnippetCopyOutcome, WebSnippetActionFailure>;
    readonly delete: (snippetId: string) => Effect.Effect<void, AccountProductReadError>;
    readonly download: (snippet: ApiSnippet) => Effect.Effect<void, WebSnippetActionFailure>;
    readonly open: (confirmedUrl: string) => Effect.Effect<void, WebSnippetActionError>;
    readonly prepareOpen: (
      snippet: ApiSnippet,
    ) => Effect.Effect<{ readonly url: string }, WebSnippetActionFailure>;
  }
>()("@plakk/web/product/snippet-actions/WebSnippetActions") {
  static readonly layer = Layer.effect(
    WebSnippetActions,
    Effect.gen(function* () {
      const browser = yield* WebSnippetActionBrowser;
      const remote = yield* WebSnippetActionRemote;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

      const read = Effect.fn("WebSnippetActions.read")(function* (snippet: ApiSnippet) {
        const downloaded = yield* remote.read(snippet.id);
        if (
          downloaded.storageProvider !== snippet.storageProvider ||
          downloaded.fileName !== snippet.fileName ||
          downloaded.byteSize !== snippet.byteSize ||
          downloaded.content.byteLength !== snippet.byteSize
        ) {
          return yield* actionError(
            null,
            "The downloaded content did not match this snippet. Try again.",
          );
        }
        return downloaded.content;
      });

      const copy = Effect.fn("WebSnippetActions.copy")(function* (snippet: ApiSnippet) {
        if (snippet.byteSize > WEB_SNIPPET_CONTENT_MAX_BYTES) {
          return yield* actionError(
            null,
            "This snippet is too large for browser Copy. Download it from the storage provider instead.",
          );
        }
        const contentResultPromise = runPromise(read(snippet).pipe(Effect.result));
        const contentPromise = contentResultPromise.then((result) => {
          if (Result.isFailure(result)) throw result.failure;
          return result.success;
        });
        void contentPromise.catch(() => undefined);
        const awaitContent = Effect.promise(() => contentResultPromise).pipe(
          Effect.flatMap((result) =>
            Result.isFailure(result) ? Effect.fail(result.failure) : Effect.succeed(result.success),
          ),
        );
        const presentation = deriveSnippetPresentation({ fileName: snippet.fileName });
        if (isTextSnippetFileName(snippet.fileName)) {
          const textPromise = contentPromise.then((content) => {
            const text = decodeSnippetText(content);
            if (text === null) {
              throw actionError(
                null,
                "This text snippet could not be decoded. Download it instead.",
              );
            }
            return text;
          });
          void textPromise.catch(() => undefined);
          const copyResult = yield* browser.copyText(textPromise).pipe(Effect.result);
          const content = yield* awaitContent;
          const decodedText = decodeSnippetText(content);
          if (decodedText === null) {
            yield* browser
              .download(content, snippet.fileName)
              .pipe(Effect.mapError(browserActionError));
            return { kind: "DOWNLOADED_FILE_FALLBACK" } as const;
          }
          if (Result.isSuccess(copyResult)) return { kind: "COPIED" } as const;
          return yield* browserActionError(copyResult.failure);
        }
        if (presentation.type !== "image") {
          const content = yield* awaitContent;
          yield* browser
            .download(content, snippet.fileName)
            .pipe(Effect.mapError(browserActionError));
          return { kind: "DOWNLOADED_FILE_FALLBACK" } as const;
        }

        const result = yield* browser
          .copyImage(contentPromise, snippet.fileName)
          .pipe(Effect.result);
        const content = yield* awaitContent;
        if (Result.isSuccess(result) && result.success === "COPIED") {
          return { kind: "COPIED" } as const;
        }
        yield* browser
          .download(content, snippet.fileName)
          .pipe(Effect.mapError(browserActionError));
        return { kind: "DOWNLOADED_IMAGE_FALLBACK" } as const;
      });

      const download = Effect.fn("WebSnippetActions.download")(function* (snippet: ApiSnippet) {
        if (snippet.byteSize > WEB_SNIPPET_CONTENT_MAX_BYTES) {
          const prepared = yield* remote.prepareDownload(snippet.id);
          if (
            prepared.storageProvider !== snippet.storageProvider ||
            prepared.fileName !== snippet.fileName ||
            prepared.byteSize !== snippet.byteSize
          ) {
            return yield* actionError(
              null,
              "The prepared download did not match this snippet. Try again.",
            );
          }
          if (
            prepared.download.headers.length !== 0 ||
            !isTrustedStorageDownloadUrl(prepared.storageProvider, prepared.download.url)
          ) {
            return yield* actionError(null, "The storage provider returned an invalid download.");
          }
          return yield* browser
            .downloadUrl(prepared.download.url, snippet.fileName)
            .pipe(Effect.mapError(browserActionError));
        }
        const content = yield* read(snippet);
        yield* browser
          .download(content, snippet.fileName)
          .pipe(Effect.mapError(browserActionError));
      });

      const readHyperlink = Effect.fn("WebSnippetActions.readHyperlink")(function* (
        snippet: ApiSnippet,
      ) {
        const content = yield* read(snippet);
        const presentation = deriveSnippetPresentation({
          fileName: snippet.fileName,
          content,
        });
        if (presentation.type !== "hyperlink") {
          return yield* actionError(null, "This snippet is not a link.");
        }
        return presentation.url;
      });

      const prepareOpen = Effect.fn("WebSnippetActions.prepareOpen")(function* (
        snippet: ApiSnippet,
      ) {
        if (snippet.byteSize > WEB_SNIPPET_CONTENT_MAX_BYTES) {
          return yield* actionError(
            null,
            "This snippet is too large for browser Open. Download it instead.",
          );
        }
        return { url: yield* readHyperlink(snippet) };
      });

      const open = Effect.fn("WebSnippetActions.open")(function* (confirmedUrl: string) {
        if (!isHttpUrl(confirmedUrl)) {
          return yield* actionError(null, "This link could not be opened.");
        }
        yield* browser.open(confirmedUrl).pipe(Effect.mapError(browserActionError));
      });

      return WebSnippetActions.of({
        copy,
        delete: remote.delete,
        download,
        open,
        prepareOpen,
      });
    }),
  );
}

const imageMediaType = (fileName: string): string => {
  const extension = fileName.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    case "heic":
      return "image/heic";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
};

const blobFromBytes = (content: Uint8Array, type: string) =>
  new Blob([Uint8Array.from(content)], { type });

const downloadableFileName = (fileName: string) =>
  fileName.split(/[\\/]/).filter(Boolean).pop() ?? "snippet";

const triggerDownload = (content: Uint8Array, fileName: string) => {
  const url = URL.createObjectURL(blobFromBytes(content, "application/octet-stream"));
  triggerDownloadUrl(url, fileName, () => URL.revokeObjectURL(url));
};

const triggerDownloadUrl = (url: string, fileName: string, onRemove?: () => void) => {
  const anchor = document.createElement("a");
  anchor.hidden = true;
  anchor.href = url;
  anchor.download = downloadableFileName(fileName);
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    onRemove?.();
  }, 1_000);
};

export const webSnippetActionBrowserLayer: Layer.Layer<WebSnippetActionBrowser> = Layer.succeed(
  WebSnippetActionBrowser,
  WebSnippetActionBrowser.of({
    copyImage: (content, fileName) => {
      if (
        navigator.clipboard?.write === undefined ||
        globalThis.ClipboardItem === undefined ||
        globalThis.createImageBitmap === undefined ||
        (ClipboardItem.supports !== undefined && !ClipboardItem.supports("image/png"))
      ) {
        return Effect.succeed("UNSUPPORTED" as const);
      }
      return Effect.tryPromise({
        try: () => {
          const png = content.then(async (bytes) => {
            const source = await createImageBitmap(blobFromBytes(bytes, imageMediaType(fileName)));
            try {
              const canvas = document.createElement("canvas");
              canvas.width = source.width;
              canvas.height = source.height;
              const context = canvas.getContext("2d");
              if (context === null) throw new Error("Canvas image decoding is unavailable.");
              context.drawImage(source, 0, 0);
              return await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob(
                  (blob) =>
                    blob === null ? reject(new Error("Image conversion failed.")) : resolve(blob),
                  "image/png",
                );
              });
            } finally {
              source.close();
            }
          });
          return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(() => {
            return "COPIED" as const;
          });
        },
        catch: (cause) =>
          new WebSnippetBrowserError({
            cause,
            message: "This image could not be copied in this browser.",
          }),
      });
    },
    copyText: (text) => {
      if (
        navigator.clipboard?.write !== undefined &&
        globalThis.ClipboardItem !== undefined &&
        (ClipboardItem.supports === undefined || ClipboardItem.supports("text/plain"))
      ) {
        return Effect.tryPromise({
          try: () =>
            navigator.clipboard.write([
              new ClipboardItem({
                "text/plain": text.then((value) =>
                  blobFromBytes(new TextEncoder().encode(value), "text/plain"),
                ),
              }),
            ]),
          catch: (cause) =>
            new WebSnippetBrowserError({
              cause,
              message: "This text could not be copied. Try again.",
            }),
        });
      }
      if (navigator.clipboard?.writeText === undefined) {
        return Effect.fail(
          new WebSnippetBrowserError({
            cause: null,
            message: "Text clipboard access is unavailable in this browser.",
          }),
        );
      }
      return Effect.tryPromise({
        try: () => text.then((value) => navigator.clipboard.writeText(value)),
        catch: (cause) =>
          new WebSnippetBrowserError({
            cause,
            message: "This text could not be copied. Try again.",
          }),
      });
    },
    download: (content, fileName) =>
      Effect.try({
        try: () => triggerDownload(content, fileName),
        catch: (cause) =>
          new WebSnippetBrowserError({
            cause,
            message: "This snippet could not be downloaded. Try again.",
          }),
      }),
    downloadUrl: (url, fileName) =>
      Effect.try({
        try: () => triggerDownloadUrl(url, fileName),
        catch: (cause) =>
          new WebSnippetBrowserError({
            cause,
            message: "This snippet could not be downloaded. Try again.",
          }),
      }),
    open: (url) =>
      Effect.try({
        try: () => void window.open(url, "_blank", "noopener,noreferrer"),
        catch: (cause) =>
          new WebSnippetBrowserError({
            cause,
            message: "This link could not be opened. Try again.",
          }),
      }),
  }),
);
