import { SNIPPETS_CHANGED } from "@plakk/shared/PlakkApi";
import { Config, Effect, Layer, Result, Stream } from "effect";

import { PlakkRpcClient } from "../../PlakkRpcClient.ts";
import {
  SnippetRemoteTransport,
  SnippetRemoteTransportError,
  type SnippetSyncAccount,
} from "./SnippetRemoteTransport.ts";

export type SnippetInvalidationFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const transportError = (cause: unknown, reason: string) =>
  new SnippetRemoteTransportError({ cause, reason });

export const snippetInvalidationsUrlFromRpcUrl = (rpcUrl: string): string => {
  const url = new URL(rpcUrl.startsWith("/") ? rpcUrl : rpcUrl, "http://localhost:3100");
  const segments = url.pathname.split("/");
  segments[segments.length - 1] = "snippets/invalidations";
  url.pathname = segments.join("/");
  return rpcUrl.startsWith("/") ? `${url.pathname}${url.search}` : url.toString();
};

export const decodeSnippetInvalidations = <E>(
  bytes: Stream.Stream<Uint8Array, E>,
): Stream.Stream<void, E> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filterMap((line) =>
      line.startsWith("data:") && line.slice("data:".length).trim() === SNIPPETS_CHANGED
        ? Result.succeed(undefined)
        : Result.fail(undefined),
    ),
  );

const snippetInvalidations = (
  fetch: SnippetInvalidationFetch,
  url: string,
  account: SnippetSyncAccount,
) =>
  Stream.unwrap(
    Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${account.accessToken}`,
          },
          signal,
        }),
      catch: (cause) => transportError(cause, "Could not connect to live Snippet updates."),
    }).pipe(
      Effect.flatMap((response) => {
        if (!response.ok) {
          return Effect.fail(
            transportError(response.status, `Live Snippet updates failed (${response.status}).`),
          );
        }
        if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
          return Effect.fail(
            transportError(null, "Live Snippet updates returned an invalid response."),
          );
        }
        if (response.body === null) {
          return Effect.fail(
            transportError(null, "Live Snippet updates returned no response body."),
          );
        }
        return Effect.succeed(
          decodeSnippetInvalidations(
            Stream.fromReadableStream({
              evaluate: () => response.body!,
              onError: (cause) =>
                transportError(cause, "The live Snippet update stream was interrupted."),
            }),
          ),
        );
      }),
    ),
  );

export const makeSnippetRemoteTransportLive = (fetch: SnippetInvalidationFetch) =>
  Layer.effect(
    SnippetRemoteTransport,
    Effect.gen(function* () {
      const client = yield* PlakkRpcClient;
      const rpcUrl = yield* Config.string("PLAKK_RPC_URL").pipe(
        Config.withDefault("https://app.plakk.io/api/rpc"),
      );
      const invalidationsUrl = snippetInvalidationsUrlFromRpcUrl(rpcUrl);
      return SnippetRemoteTransport.of({
        snapshot: Effect.fn("DesktopSnippetRemote.snapshot")(function* (account) {
          return yield* client.GetSnippetSnapshot(undefined, {
            headers: { authorization: `Bearer ${account.accessToken}` },
          });
        }),
        invalidations: (account) => snippetInvalidations(fetch, invalidationsUrl, account),
      });
    }),
  );
