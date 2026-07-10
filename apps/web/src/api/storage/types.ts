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
