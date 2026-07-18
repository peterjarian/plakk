import { Effect, Layer } from "effect";

import { PlakkRpcClient } from "../../PlakkRpcClient.ts";
import { SnippetUploadRemote } from "./SnippetUploadRemote.ts";

const headers = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

export const SnippetUploadRemoteLive = Layer.effect(
  SnippetUploadRemote,
  Effect.gen(function* () {
    const client = yield* PlakkRpcClient;
    return SnippetUploadRemote.of({
      create: Effect.fn("SnippetUploadRemote.create")((accessToken, input) =>
        client.CreateStoredSnippet(input, { headers: headers(accessToken) }),
      ),
      prepare: Effect.fn("SnippetUploadRemote.prepare")((accessToken, input) =>
        client.PrepareStoredSnippetUpload(input, { headers: headers(accessToken) }),
      ),
      heartbeat: Effect.fn("SnippetUploadRemote.heartbeat")((accessToken, id) =>
        client.HeartbeatStoredSnippetUpload({ id }, { headers: headers(accessToken) }),
      ),
      fail: Effect.fn("SnippetUploadRemote.fail")((accessToken, id) =>
        client.FailStoredSnippetUpload({ id }, { headers: headers(accessToken) }),
      ),
      retry: Effect.fn("SnippetUploadRemote.retry")((accessToken, id) =>
        client.RetryStoredSnippetUpload({ id }, { headers: headers(accessToken) }),
      ),
      complete: Effect.fn("SnippetUploadRemote.complete")((accessToken, input) =>
        client.CompleteStoredSnippetUpload(input, { headers: headers(accessToken) }),
      ),
      delete: Effect.fn("SnippetUploadRemote.delete")((accessToken, id) =>
        client.DeleteSnippet({ id }, { headers: headers(accessToken) }),
      ),
    });
  }),
);
