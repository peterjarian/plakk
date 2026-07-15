import { RpcError } from "@plakk/shared/RpcError";

import type { StorageDownloadError } from "./StorageProvider.ts";

export const toStorageRpcError = (error: StorageDownloadError): RpcError => {
  switch (error._tag) {
    case "StorageObjectNotFoundError":
      return new RpcError({ code: "NOT_FOUND", message: error.message });
    case "StorageNotConnectedError":
    case "StorageNeedsReauthorizationError":
      return new RpcError({ code: "FORBIDDEN", message: error.message });
    case "StorageCredentialsError":
      return new RpcError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
    case "StorageProviderError":
      return new RpcError({
        code: "INTERNAL_SERVER_ERROR",
        message: `${error.storageProvider}: ${error.message}`,
      });
  }
};
