import * as Schema from "effect/Schema";

export const STORAGE_PROVIDERS = ["GOOGLE_DRIVE", "ONE_DRIVE", "DROPBOX"] as const;

export const StorageProviderLiteral = Schema.Literals(STORAGE_PROVIDERS);

export type StorageProvider = typeof StorageProviderLiteral.Type;

export const UserSchema = Schema.Struct({
  id: Schema.String,
  firstName: Schema.NullOr(Schema.String),
  lastName: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});

export type User = typeof UserSchema.Type;

export const SNIPPET_KINDS = ["TEXT", "LINK", "FILE", "IMAGE"] as const;

export const SnippetKindLiteral = Schema.Literals(SNIPPET_KINDS);

export type SnippetKind = typeof SnippetKindLiteral.Type;

export const SNIPPET_UPLOAD_STATUSES = ["UPLOADING", "READY", "FAILED"] as const;

export const SnippetUploadStatusLiteral = Schema.Literals(SNIPPET_UPLOAD_STATUSES);

export type SnippetUploadStatus = typeof SnippetUploadStatusLiteral.Type;

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
