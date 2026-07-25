import { Effect, Layer } from "effect";

import { PlakkRpcClient } from "../../PlakkRpcClient.ts";
import { SnippetUploadRemote } from "./SnippetUploadRemote.ts";

const headers = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

export const SnippetUploadRemoteLive = Layer.effect(
  SnippetUploadRemote,
  Effect.gen(function* () {
    const client = yield* PlakkRpcClient;
    return SnippetUploadRemote.of({
      prepare: Effect.fn("SnippetUploadRemote.prepare")((accessToken, input) =>
        client.PrepareSnippetUpload(input, { headers: headers(accessToken) }),
      ),
      publish: Effect.fn("SnippetUploadRemote.publish")((accessToken, input) =>
        client.PublishSnippet(input, { headers: headers(accessToken) }),
      ),
    });
  }),
);
