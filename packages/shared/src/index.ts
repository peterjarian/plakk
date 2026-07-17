import * as Schema from "effect/Schema";

export * from "./SnippetPresentation.ts";

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

export const SNIPPET_UPLOAD_STATUSES = ["UPLOADING", "FAILED", "UPLOADED"] as const;

export const SnippetUploadStatusLiteral = Schema.Literals(SNIPPET_UPLOAD_STATUSES);

export type SnippetUploadStatus = typeof SnippetUploadStatusLiteral.Type;

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
