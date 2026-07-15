import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";

import {
  StorageCredentialsError,
  StorageNeedsReauthorizationError,
  StorageNotConnectedError,
} from "./StorageProvider.ts";
import { mapStorageErrorsToRpc } from "./mapStorageErrorsToRpc.ts";
import { StorageObjectNotFoundError, StorageProviderError } from "./types.ts";

describe("mapStorageErrorsToRpc", () => {
  it.each([
    [
      new StorageObjectNotFoundError({ storageProvider: "GOOGLE_DRIVE", message: "missing" }),
      "NOT_FOUND",
      "missing",
    ],
    [new StorageNotConnectedError({ message: "connect storage" }), "FORBIDDEN", "connect storage"],
    [
      new StorageNeedsReauthorizationError({ message: "reconnect storage" }),
      "FORBIDDEN",
      "reconnect storage",
    ],
    [
      new StorageCredentialsError({ message: "credentials unavailable" }),
      "INTERNAL_SERVER_ERROR",
      "credentials unavailable",
    ],
    [
      new StorageProviderError({ storageProvider: "GOOGLE_DRIVE", message: "provider failed" }),
      "INTERNAL_SERVER_ERROR",
      "GOOGLE_DRIVE: provider failed",
    ],
  ] as const)("maps %s to %s", async (storageError, code, message) => {
    const error = await Effect.runPromise(
      Effect.flip(mapStorageErrorsToRpc(Effect.fail(storageError))),
    );

    expect(error).toMatchObject({ code, message });
  });
});
