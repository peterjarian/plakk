import * as Schema from "effect/Schema";

import { ApiSnippetSchema, SnippetIdSchema, type ApiSnippet } from "./api/PlakkApi.ts";
import { StorageProviderLiteral } from "./StorageProvider.ts";

export const LocalUploadRecordSchema = Schema.Struct({
  kind: Schema.Literal("LOCAL"),
  id: SnippetIdSchema,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  storageProvider: StorageProviderLiteral,
  status: Schema.Literals(["UPLOADING", "FAILED"] as const),
  errorMessage: Schema.NullOr(Schema.String),
  publicationCandidate: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        storageObjectId: Schema.String,
      }),
    ),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export type LocalUploadRecord = typeof LocalUploadRecordSchema.Type;

export const PublishedSnippetRecordSchema = Schema.Struct({
  kind: Schema.Literal("PUBLISHED"),
  snippet: ApiSnippetSchema,
});

export type PublishedSnippetRecord = typeof PublishedSnippetRecordSchema.Type;

export const DeviceSnippetRecordSchema = Schema.Union([
  LocalUploadRecordSchema,
  PublishedSnippetRecordSchema,
]);

export type DeviceSnippetRecord = typeof DeviceSnippetRecordSchema.Type;

export const deviceSnippetRecordId = (record: DeviceSnippetRecord): string =>
  record.kind === "LOCAL" ? record.id : record.snippet.id;

const recordCreatedAt = (record: DeviceSnippetRecord): string =>
  record.kind === "LOCAL" ? record.createdAt : record.snippet.createdAt;

const matchesPublicationCandidate = (local: LocalUploadRecord, snippet: ApiSnippet): boolean => {
  // Records persisted before publication candidates were introduced retain their prior
  // identity-only reconciliation. New upload flows always write null, then the provider identity.
  if (local.publicationCandidate === undefined) return true;
  return (
    local.publicationCandidate !== null &&
    local.fileName === snippet.fileName &&
    local.byteSize === snippet.byteSize &&
    local.storageProvider === snippet.storageProvider &&
    local.publicationCandidate.storageObjectId === snippet.storageObjectId
  );
};

export const orderDeviceSnippetRecords = (
  records: Iterable<DeviceSnippetRecord>,
): ReadonlyArray<DeviceSnippetRecord> =>
  Array.from(records).sort((left, right) =>
    recordCreatedAt(right).localeCompare(recordCreatedAt(left)),
  );

export const reconcileDeviceSnippetRecords = (
  current: ReadonlyArray<DeviceSnippetRecord>,
  snapshot: ReadonlyArray<ApiSnippet>,
): ReadonlyArray<DeviceSnippetRecord> => {
  const published = new Map(snapshot.map((snippet) => [snippet.id, snippet]));
  const unmatchedLocal = current.filter(
    (record) =>
      record.kind === "LOCAL" &&
      (published.get(record.id) === undefined ||
        !matchesPublicationCandidate(record, published.get(record.id)!)),
  );
  return orderDeviceSnippetRecords([
    ...unmatchedLocal,
    ...Array.from(published.values(), (snippet) => ({
      kind: "PUBLISHED" as const,
      snippet,
    })),
  ]);
};
