import type { PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import { Context, type Effect, Schema } from "effect";

export type PreparedFileUploadPayload = {
  readonly id: string;
  readonly prepared: PreparedStorageUpload;
  readonly byteSize: number;
  readonly filePath: string;
};

export type StorageUploadResult = { readonly storageObjectId: string };
export type UploadFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class StorageUploadError extends Schema.TaggedErrorClass<StorageUploadError>()(
  "StorageUploadError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export class StorageUpload extends Context.Service<
  StorageUpload,
  {
    readonly upload: (
      payload: PreparedFileUploadPayload,
    ) => Effect.Effect<StorageUploadResult, StorageUploadError>;
  }
>()("plakk/main/snippets/upload/StorageUpload") {}
