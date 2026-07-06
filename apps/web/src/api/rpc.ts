import { RpcError } from "@plakk/shared/RpcError";
import { InternalServerErrorMiddleware, PlakkApi } from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { PlakkBackend } from "./PlakkBackend.ts";

const InternalServerErrorLive = Layer.succeed(InternalServerErrorMiddleware)(
  InternalServerErrorMiddleware.of((effect) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        Effect.gen(function* () {
          const traceId = yield* Effect.currentSpan.pipe(
            Effect.map((span) => span.traceId),
            Effect.orElseSucceed(() => "untraced"),
          );

          yield* Effect.logError("Unhandled RPC defect", { defect, traceId });

          return yield* new RpcError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Something went wrong. Please try again.",
            traceId,
          });
        }),
      ),
    ),
  ),
);

const PlakkApiHandlers = PlakkApi.toLayer(
  PlakkApi.of({
    Ping: () =>
      Effect.succeed({ ok: true }).pipe(
        Effect.tap(() => Effect.logInfo("Ping")),
        Effect.withSpan("rpc.Ping"),
      ),
    GetAccountStatus: () =>
      PlakkBackend.pipe(
        Effect.flatMap((backend) => backend.getAccountStatus),
        Effect.withSpan("rpc.GetAccountStatus"),
      ),
    ListSnippets: (input) =>
      PlakkBackend.pipe(
        Effect.flatMap((backend) => backend.listSnippets(input)),
        Effect.withSpan("rpc.ListSnippets", {
          attributes: { limit: input.limit },
        }),
      ),
    CreateTextSnippet: (input) =>
      PlakkBackend.pipe(
        Effect.flatMap((backend) => backend.createTextSnippet(input.text)),
        Effect.withSpan("rpc.CreateTextSnippet", { attributes: { byteSize: input.text.length } }),
      ),
    CreateStoredSnippet: (input) =>
      PlakkBackend.pipe(
        Effect.flatMap((backend) => backend.createStoredSnippet(input)),
        Effect.withSpan("rpc.CreateStoredSnippet", {
          attributes: { kind: input.kind },
        }),
      ),
    DeleteSnippet: (input) =>
      PlakkBackend.pipe(
        Effect.flatMap((backend) => backend.deleteSnippet(input.id)),
        Effect.withSpan("rpc.DeleteSnippet", { attributes: { id: input.id } }),
      ),
  }),
);

const RpcRoutes = RpcServer.layerHttp({
  group: PlakkApi,
  path: "/api/rpc",
  protocol: "http",
  disableFatalDefects: true,
}).pipe(
  Layer.provide(PlakkApiHandlers),
  Layer.provide(PlakkBackend.Live),
  Layer.provide(InternalServerErrorLive),
  Layer.provide(RpcSerialization.layerNdjson),
);

export const { handler: handleRpcRequest } = HttpRouter.toWebHandler(RpcRoutes, {
  disableLogger: true,
});
