export type SnippetPresentation =
  | { readonly type: "file" | "image" | "text"; readonly title: string }
  | { readonly type: "hyperlink"; readonly title: string; readonly url: string };

const imageFileName = /\.(avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)$/i;
const textFileName =
  /\.(asc|conf|css|csv|htm|html|ini|js|json|jsx|log|md|markdown|mjs|mts|sh|sql|toml|ts|tsx|txt|xml|ya?ml)$/i;

export const isTextSnippetFileName = (fileName: string): boolean => textFileName.test(fileName);

export const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export const decodeSnippetText = (content: string | Uint8Array | undefined): string | null => {
  if (content === undefined) return null;
  if (typeof content === "string") return content;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
};

export const SNIPPET_TEXT_PREVIEW_MAX_BYTES = 64 * 1024;

export const isValidSnippetText = (content: Uint8Array): boolean => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (let offset = 0; offset < content.byteLength; offset += SNIPPET_TEXT_PREVIEW_MAX_BYTES) {
      decoder.decode(content.subarray(offset, offset + SNIPPET_TEXT_PREVIEW_MAX_BYTES), {
        stream: true,
      });
    }
    decoder.decode();
    return true;
  } catch {
    return false;
  }
};

export const decodeSnippetTextPreview = (
  content: string | Uint8Array,
  truncated = typeof content !== "string" && content.byteLength > SNIPPET_TEXT_PREVIEW_MAX_BYTES,
): string | null => {
  if (typeof content === "string") return content.slice(0, SNIPPET_TEXT_PREVIEW_MAX_BYTES);
  const preview = content.subarray(0, SNIPPET_TEXT_PREVIEW_MAX_BYTES);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(preview, { stream: truncated });
  } catch {
    return null;
  }
};

export const deriveSnippetPresentation = (input: {
  readonly fileName: string;
  readonly content?: string | Uint8Array;
}): SnippetPresentation => {
  if (imageFileName.test(input.fileName)) {
    return { type: "image", title: input.fileName };
  }
  if (!isTextSnippetFileName(input.fileName)) {
    return { type: "file", title: input.fileName };
  }

  const text = decodeSnippetText(input.content)?.trim();
  if (text === undefined || text === null) {
    return { type: "file", title: "Text snippet" };
  }
  if (text !== undefined && text !== null && isHttpUrl(text)) {
    return { type: "hyperlink", title: text, url: text };
  }
  const title = text?.split(/\r?\n/, 1)[0]?.trim() || "Text snippet";
  return { type: "text", title };
};
