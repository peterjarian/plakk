export const encodeTextSnippet = (text: string) => new TextEncoder().encode(text);

export const decodeTextSnippet = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("This text snippet is not valid UTF-8.");
  }
};
