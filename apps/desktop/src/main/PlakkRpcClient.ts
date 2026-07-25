import { PlakkApi } from "@plakk/shared/PlakkApi";
import { Context } from "effect";
import type { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";

export class PlakkRpcClient extends Context.Service<
  PlakkRpcClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof PlakkApi>, RpcClientError>
>()("plakk/main/PlakkRpcClient") {}
