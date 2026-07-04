import * as Schema from "effect/Schema";

export const UserSchema = Schema.Struct({
  id: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});

export type User = typeof UserSchema.Type;

export type DeepPartial<T> =
  T extends ReadonlyArray<infer Item>
    ? ReadonlyArray<DeepPartial<Item>>
    : T extends object
      ? { readonly [Key in keyof T]?: DeepPartial<T[Key]> }
      : T;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export const deepMerge = <T>(current: T, patch: DeepPartial<T>): T => {
  if (!isPlainRecord(current) || !isPlainRecord(patch)) return patch as T;

  const next: Record<string, unknown> = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    const existing = next[key];
    next[key] =
      isPlainRecord(existing) && isPlainRecord(value) ? deepMerge(existing, value) : value;
  }

  return next as T;
};

export const STORAGE_PROVIDERS = ["googleDrive", "oneDrive", "dropbox"] as const;

export const StorageProviderLiteral = Schema.Literals(STORAGE_PROVIDERS);

export type StorageProvider = typeof StorageProviderLiteral.Type;

export const SNIPPET_KINDS = ["TEXT", "LINK", "FILE", "IMAGE"] as const;

export const SnippetKindLiteral = Schema.Literals(SNIPPET_KINDS);

export type SnippetKind = typeof SnippetKindLiteral.Type;

export const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const formatFileSizeNumber = (value: number) =>
  value >= 100 ? value.toFixed(0) : value.toFixed(1);

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const kb = bytes / 1024;
  if (kb < 1024) return `${formatFileSizeNumber(kb)} KB`;

  const mb = kb / 1024;
  if (mb < 1024) return `${formatFileSizeNumber(mb)} MB`;

  return `${formatFileSizeNumber(mb / 1024)} GB`;
}

export const snippetKindForFileName = (name: string): SnippetKind =>
  /\.(avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)$/i.test(name) ? "IMAGE" : "FILE";

export const SnippetSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  subtitle: Schema.String,
  kind: SnippetKindLiteral,
  time: Schema.String,
  synced: Schema.Boolean,
  uploadProgress: Schema.optionalKey(Schema.Finite),
});

export type Snippet = typeof SnippetSchema.Type;
