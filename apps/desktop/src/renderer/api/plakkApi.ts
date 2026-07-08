import { PlakkApi } from "@plakk/shared/PlakkApi";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

const DEFAULT_PLAKK_API_RPC_URL = "http://localhost:3000/api/rpc";
const plakkApiRpcUrl = import.meta.env.VITE_PLAKK_API_RPC_URL || DEFAULT_PLAKK_API_RPC_URL;

type PlakkApiClient = RpcClient.FromGroup<typeof PlakkApi, RpcClientError>;

function callPlakkApi<A>(useClient: (client: PlakkApiClient) => Effect.Effect<A, unknown>) {
  return Effect.gen(function* () {
    const accessToken = yield* Effect.promise(() => window.ipc.auth.getAccessToken());
    if (accessToken === null) return yield* Effect.fail(new Error("Sign in to continue."));

    const client = yield* RpcClient.make(PlakkApi);
    return yield* useClient(client).pipe(
      RpcClient.withHeaders({ authorization: `Bearer ${accessToken}` }),
    );
  }).pipe(
    Effect.provide(RpcClient.layerProtocolHttp({ url: plakkApiRpcUrl })),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(RpcSerialization.layerNdjson),
    Effect.scoped,
  );
}

function runPlakkApi<A>(effect: (client: PlakkApiClient) => Effect.Effect<A, unknown>) {
  return Effect.runPromise(callPlakkApi(effect));
}

export const plakkApi = {
  createStoredSnippet: (payload: Parameters<PlakkApiClient["CreateStoredSnippet"]>[0]) =>
    runPlakkApi((client) => client.CreateStoredSnippet(payload)),
  createTextSnippet: (payload: Parameters<PlakkApiClient["CreateTextSnippet"]>[0]) =>
    runPlakkApi((client) => client.CreateTextSnippet(payload)),
  deleteSnippet: (payload: Parameters<PlakkApiClient["DeleteSnippet"]>[0]) =>
    runPlakkApi((client) => client.DeleteSnippet(payload)),
  listSnippets: (payload: Parameters<PlakkApiClient["ListSnippets"]>[0]) =>
    runPlakkApi((client) => client.ListSnippets(payload)),
  prepareStoredSnippetUpload: (
    payload: Parameters<PlakkApiClient["PrepareStoredSnippetUpload"]>[0],
  ) => runPlakkApi((client) => client.PrepareStoredSnippetUpload(payload)),
  updateStoredSnippetUploadStatus: (
    payload: Parameters<PlakkApiClient["UpdateStoredSnippetUploadStatus"]>[0],
  ) => runPlakkApi((client) => client.UpdateStoredSnippetUploadStatus(payload)),
};
