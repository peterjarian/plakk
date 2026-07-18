import "dotenv/config";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { createServer } from "node:http";

import { RpcRoutes } from "./api/rpc.ts";
import { ServerRuntimeLive } from "./api/ServerRuntime.ts";

const BackendRoutes = Layer.mergeAll(
  RpcRoutes.pipe(Layer.provide(ServerRuntimeLive)),
  HttpRouter.cors({
    allowedOrigins: ["plakk-app://renderer"],
    allowedMethods: ["POST", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type"],
    maxAge: 86_400,
  }),
);

const NodeServerLive = NodeHttpServer.layerConfig(createServer, {
  host: Config.string("PLAKK_BACKEND_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.int("PORT").pipe(Config.withDefault(3100)),
});

export const BackendLive = HttpRouter.serve(BackendRoutes).pipe(Layer.provide(NodeServerLive));

NodeRuntime.runMain(Layer.launch(BackendLive));
