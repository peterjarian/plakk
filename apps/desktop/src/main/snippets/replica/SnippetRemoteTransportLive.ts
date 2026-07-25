import { SNIPPETS_CHANGED, type SnippetInvalidationEvent } from "@plakk/shared/PlakkApi";
import { Effect, Layer, Stream } from "effect";

import { PlakkRpcClient } from "../../PlakkRpcClient.ts";
import { SnippetRemoteTransport } from "./SnippetRemoteTransport.ts";

export const selectSnippetInvalidations = <E>(
  events: Stream.Stream<SnippetInvalidationEvent, E>,
): Stream.Stream<void, E> =>
  events.pipe(
    Stream.filter((event) => event === SNIPPETS_CHANGED),
    Stream.map(() => undefined),
  );

export const SnippetRemoteTransportLive = Layer.effect(
  SnippetRemoteTransport,
  Effect.gen(function* () {
    const client = yield* PlakkRpcClient;
    return SnippetRemoteTransport.of({
      snapshot: Effect.fn("DesktopSnippetRemote.snapshot")(function* (account) {
        return yield* client.GetSnippetSnapshot(undefined, {
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
      }),
      invalidations: (account) =>
        selectSnippetInvalidations(
          client.WatchSnippetInvalidations(undefined, {
            headers: { authorization: `Bearer ${account.accessToken}` },
          }),
        ),
    });
  }),
);
