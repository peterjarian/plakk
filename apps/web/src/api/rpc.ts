import { PlakkApi } from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

const PlakkApiHandlers = PlakkApi.toLayer(
  PlakkApi.of({
    Ping: () => Effect.succeed({ ok: true }),
  }),
);

const RpcRoutes = RpcServer.layerHttp({
  group: PlakkApi,
  path: "/api/rpc",
  protocol: "http",
  disableFatalDefects: true,
}).pipe(Layer.provide([PlakkApiHandlers, RpcSerialization.layerNdjson]));

export const { handler: handleRpcRequest } = HttpRouter.toWebHandler(RpcRoutes, {
  disableLogger: true,
});
