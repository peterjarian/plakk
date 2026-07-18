import type { StorageProvider } from "@plakk/shared";
import { RpcError } from "@plakk/shared/RpcError";
import { net } from "electron";
import { Effect, Layer, Stream } from "effect";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import { PlakkRpcClient } from "../PlakkRpcClient.ts";
import { SnippetHydrationError, SnippetHydrationTransport } from "../Services/SnippetHydration.ts";

type SnippetFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const hydrationError = (cause: unknown, reason: string, retryable: boolean) =>
  new SnippetHydrationError({ cause, reason, retryable });

const preparationError = (cause: RpcError | RpcClientError) => {
  if (!(cause instanceof RpcError)) {
    return hydrationError(cause, "Could not connect to Plakk.", true);
  }
  switch (cause.code) {
    case "UNAUTHENTICATED":
      return hydrationError(cause, "Reconnect your account to download this snippet.", false);
    case "NOT_FOUND":
      return hydrationError(cause, "This snippet is no longer available to download.", false);
    case "FORBIDDEN":
      return hydrationError(cause, "Reconnect storage to download this snippet.", false);
    case "CONFLICT":
      return hydrationError(cause, "This snippet is not ready to download.", false);
    case "INTERNAL_SERVER_ERROR":
      return hydrationError(cause, "Plakk could not prepare this download.", true);
  }
};

export const isSignedStorageDownloadUrl = (
  storageProvider: StorageProvider,
  value: string,
): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (storageProvider === "GOOGLE_DRIVE") {
      return (
        url.hostname === "www.googleapis.com" ||
        url.hostname === "drive.google.com" ||
        url.hostname === "drive.usercontent.google.com" ||
        url.hostname.endsWith(".googleusercontent.com")
      );
    }
    if (storageProvider === "ONE_DRIVE") {
      return url.hostname.endsWith(".1drv.com") || url.hostname.endsWith(".sharepoint.com");
    }
    return url.hostname.endsWith(".dropboxusercontent.com");
  } catch {
    return false;
  }
};

export const snippetHydrationTransportLayer = (fetch: SnippetFetch) =>
  Layer.effect(
    SnippetHydrationTransport,
    Effect.gen(function* () {
      const client = yield* PlakkRpcClient;

      return SnippetHydrationTransport.of({
        stream: (account, snippet) =>
          Stream.unwrap(
            client
              .PrepareSnippetDownload(
                { id: snippet.id },
                { headers: { authorization: `Bearer ${account.accessToken}` } },
              )
              .pipe(
                Effect.mapError(preparationError),
                Effect.flatMap((prepared) => {
                  if (
                    prepared.storageProvider !== snippet.storageProvider ||
                    prepared.fileName !== snippet.fileName ||
                    prepared.byteSize !== snippet.byteSize
                  ) {
                    return Effect.fail(
                      hydrationError(
                        null,
                        "The prepared download does not match this snippet.",
                        false,
                      ),
                    );
                  }
                  if (
                    !isSignedStorageDownloadUrl(prepared.storageProvider, prepared.download.url)
                  ) {
                    return Effect.fail(
                      hydrationError(
                        null,
                        "The storage provider returned an invalid download.",
                        false,
                      ),
                    );
                  }
                  return Effect.tryPromise({
                    try: (signal) =>
                      fetch(prepared.download.url, {
                        headers: Object.fromEntries(
                          prepared.download.headers.map(({ name, value }) => [name, value]),
                        ),
                        signal,
                      }),
                    catch: (cause) =>
                      hydrationError(cause, "Could not connect to the storage provider.", true),
                  });
                }),
                Effect.flatMap((response) => {
                  if (!response.ok) {
                    return Effect.fail(
                      hydrationError(
                        null,
                        `Storage download failed (${response.status}).`,
                        response.status === 408 ||
                          response.status === 429 ||
                          response.status >= 500,
                      ),
                    );
                  }
                  if (snippet.byteSize === 0) return Effect.succeed(Stream.empty);
                  if (response.body === null) {
                    return Effect.fail(
                      hydrationError(null, "The storage provider returned no content.", true),
                    );
                  }
                  return Effect.succeed(
                    Stream.fromReadableStream({
                      evaluate: () => response.body!,
                      onError: (cause) =>
                        hydrationError(cause, "The storage download was interrupted.", true),
                    }),
                  );
                }),
              ),
          ),
      });
    }),
  );

export const SnippetHydrationTransportLive = snippetHydrationTransportLayer((input, init) =>
  net.fetch(input.toString(), init),
);
