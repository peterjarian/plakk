import { AuthMiddleware, PlakkApi } from "@plakk/shared/PlakkApi";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";
import { Headers } from "effect/unstable/http";
import * as EffectRpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";
import { CurrentSession } from "./CurrentSession.ts";

/**
 * Adds the current session's bearer token to every RPC protected by the shared
 * authentication middleware.
 */
export const AuthClientLive = RpcMiddleware.layerClient(
  AuthMiddleware,
  Effect.gen(function* () {
    const session = yield* CurrentSession;
    return ({ request, next }) =>
      session.accessToken.pipe(
        Effect.flatMap((accessToken) =>
          next({
            ...request,
            headers: Headers.set(request.headers, "authorization", `Bearer ${accessToken}`),
          }),
        ),
      );
  }),
);

/**
 * The complete Plakk backend client inferred directly from the shared RPC
 * contract. Platforms provide its transport layer and the current session.
 */
export class RpcClient extends Context.Service<
  RpcClient,
  EffectRpcClient.RpcClient<RpcGroup.Rpcs<typeof PlakkApi>, RpcClientError>
>()("@plakk/client-runtime/RpcClient") {
  static readonly Live = Layer.effect(RpcClient, EffectRpcClient.make(PlakkApi)).pipe(
    Layer.provide(AuthClientLive),
  );
}
