import { PlakkApi } from "@plakk/shared/PlakkApi";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { AtomRpc } from "effect/unstable/reactivity";

export const createPlakkRpc = (rpcUrl: string) => {
  class PlakkRpc extends AtomRpc.Service<PlakkRpc>()("plakk/ui/atoms/PlakkRpc", {
    group: PlakkApi,
    protocol: RpcClient.layerProtocolHttp({ url: rpcUrl }).pipe(
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(RpcSerialization.layerNdjson),
    ),
  }) {}

  return {
    query: PlakkRpc.query,
    mutation: PlakkRpc.mutation,
  };
};
