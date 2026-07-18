import { PlakkApi } from "@plakk/shared/PlakkApi";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { PlakkRpcClient } from "./PlakkRpcClient.ts";

export const PlakkRpcClientLive = Layer.effect(PlakkRpcClient, RpcClient.make(PlakkApi));

export const plakkRpcProtocolLayer = Layer.unwrap(
  Config.string("PLAKK_RPC_URL").pipe(
    Config.withDefault("https://app.plakk.io/api/rpc"),
    Effect.orDie,
    Effect.map((configuredRpcUrl) => {
      const url = configuredRpcUrl.startsWith("/")
        ? new URL(configuredRpcUrl, "http://localhost:3100").toString()
        : configuredRpcUrl;
      return RpcClient.layerProtocolHttp({ url }).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(RpcSerialization.layerNdjson),
      );
    }),
  ),
);
