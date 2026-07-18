import type { SnippetChangePage } from "@plakk/shared/PlakkApi";
import { Effect, Layer, Stream } from "effect";

import { PlakkRpcClient } from "../../PlakkRpcClient.ts";
import { SnippetRemoteTransport } from "./SnippetRemoteTransport.ts";

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
      pull: Effect.fn("DesktopSnippetRemote.pull")(function* (account, cursor) {
        const page: SnippetChangePage = yield* client.PullSnippetChanges(
          { cursor, limit: 100 },
          { headers: { authorization: `Bearer ${account.accessToken}` } },
        );
        return page;
      }),
      wakes: (account) =>
        client
          .SubscribeSnippetChanges(undefined, {
            headers: { authorization: `Bearer ${account.accessToken}` },
          })
          .pipe(Stream.map(() => undefined)),
    });
  }),
);
