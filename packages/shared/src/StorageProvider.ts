import * as Schema from "effect/Schema";

export const STORAGE_PROVIDERS = ["GOOGLE_DRIVE", "ONE_DRIVE", "DROPBOX"] as const;

export const StorageProviderLiteral = Schema.Literals(STORAGE_PROVIDERS);

export type StorageProvider = typeof StorageProviderLiteral.Type;
