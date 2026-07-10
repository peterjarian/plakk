import { StorageProviderLiteral, type StorageProvider } from "@plakk/shared";
import type { PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import * as Schema from "effect/Schema";

export class StorageProviderError extends Schema.TaggedErrorClass<StorageProviderError>()(
  "StorageProviderError",
  {
    storageProvider: StorageProviderLiteral,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class StorageObjectNotFoundError extends Schema.TaggedErrorClass<StorageObjectNotFoundError>()(
  "StorageObjectNotFoundError",
  {
    storageProvider: StorageProviderLiteral,
    message: Schema.String,
  },
) {}

export type { PreparedStorageUpload };

export type StorageProviderDestination = {
  readonly url: string;
};

export type PrepareStorageUploadInput = {
  readonly accessToken: string;
  readonly snippetId: string;
  readonly storageProvider: StorageProvider;
  readonly fileName: string;
  readonly byteSize: number;
  readonly contentType: string | null;
};

export type DownloadStorageObjectInput = {
  readonly accessToken: string;
  readonly storageProvider: StorageProvider;
  readonly storageObjectId: string;
  readonly expectedByteSize: number;
};
