import { PlakkApi } from "@plakk/shared/PlakkApi";
import { Effect, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type {
  CreateStoredSnippetPayload,
  CreateTextSnippetPayload,
  DeleteSnippetPayload,
  ListSnippetsPayload,
  PrepareStoredSnippetUploadPayload,
  UpdateStoredSnippetUploadStatusPayload,
} from "@plakk/shared/PlakkApi";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

const DEFAULT_PLAKK_API_RPC_URL = "http://localhost:3000/api/rpc";
const plakkApiRpcUrl =
  window.ipc.plakkApiRpcUrl || import.meta.env.VITE_PLAKK_API_RPC_URL || DEFAULT_PLAKK_API_RPC_URL;

type PlakkApiClient = RpcClient.FromGroup<typeof PlakkApi, RpcClientError>;

function errorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return fallback;
}

function callPlakkApi<A>(useClient: (client: PlakkApiClient) => Effect.Effect<A, unknown>) {
  return Effect.gen(function* () {
    const accessToken = yield* Effect.promise(() => window.ipc.auth.getAccessToken());
    if (accessToken === null) {
      return yield* Effect.fail(new Error("Sign in to continue."));
    }

    const client = yield* RpcClient.make(PlakkApi);
    return yield* useClient(client).pipe(
      RpcClient.withHeaders({ authorization: `Bearer ${accessToken}` }),
    );
  }).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({
        url: plakkApiRpcUrl,
      }),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(RpcSerialization.layerNdjson),
    Effect.scoped,
  );
}

async function runPlakkApi<A>(
  effect: (client: PlakkApiClient) => Effect.Effect<A, unknown>,
  fallback: string,
): Promise<A> {
  const result = await Effect.runPromise(Effect.result(callPlakkApi(effect)));

  if (!Result.isSuccess(result)) {
    throw new Error(errorMessage(result.failure, fallback));
  }

  return result.success;
}

export const plakkApi = {
  createStoredSnippet: (payload: CreateStoredSnippetPayload) =>
    runPlakkApi(
      (client) => client.CreateStoredSnippet(payload),
      "Could not create stored snippet.",
    ),
  createTextSnippet: (payload: CreateTextSnippetPayload) =>
    runPlakkApi((client) => client.CreateTextSnippet(payload), "Could not create text snippet."),
  deleteSnippet: (payload: DeleteSnippetPayload) =>
    runPlakkApi((client) => client.DeleteSnippet(payload), "Could not delete snippet."),
  listSnippets: (payload: ListSnippetsPayload) =>
    runPlakkApi((client) => client.ListSnippets(payload), "Could not load snippets."),
  prepareStoredSnippetUpload: (payload: PrepareStoredSnippetUploadPayload) =>
    runPlakkApi(
      (client) => client.PrepareStoredSnippetUpload(payload),
      "Could not prepare stored snippet upload.",
    ),
  updateStoredSnippetUploadStatus: (payload: UpdateStoredSnippetUploadStatusPayload) =>
    runPlakkApi(
      (client) => client.UpdateStoredSnippetUploadStatus(payload),
      "Could not update upload status.",
    ),
} as const;
