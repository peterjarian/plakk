import { StorageProviderLiteral, type StorageProvider } from "@plakk/shared";
import type * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Schema from "effect/Schema";

export class StorageProviderError extends Schema.TaggedErrorClass<StorageProviderError>()(
  "StorageProviderError",
  {
    storageProvider: StorageProviderLiteral,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export type PreparedStorageUpload = {
  readonly storageProvider: StorageProvider;
  readonly storageObjectId: string | null;
  readonly upload: {
    readonly method: "POST" | "PUT";
    readonly url: string;
    readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    readonly strategy:
      | { readonly type: "single_request" }
      | {
          readonly type: "byte_range";
          readonly maxPartByteSize: number;
          readonly partByteMultiple: number;
        };
  };
  readonly expiresAt: string | null;
};

export type PrepareStorageUploadInput = {
  readonly accessToken: string;
  readonly storageProvider: StorageProvider;
  readonly fileName: string;
  readonly byteSize: number;
  readonly contentType: string | null;
};

export type StorageProviderAdapter = {
  readonly prepareUpload: (
    input: PrepareStorageUploadInput,
  ) => Effect.Effect<PreparedStorageUpload, StorageProviderError, HttpClient.HttpClient>;
};
