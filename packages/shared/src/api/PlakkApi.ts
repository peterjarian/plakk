import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

import { RpcError } from "./RpcError.ts";

export const PingResultSchema = Schema.Struct({
  ok: Schema.Boolean,
});

export type PingResult = typeof PingResultSchema.Type;

class Ping extends Rpc.make("Ping", {
  success: PingResultSchema,
  error: RpcError,
}) {}

export class InternalServerErrorMiddleware extends RpcMiddleware.Service<InternalServerErrorMiddleware>()(
  "InternalServerErrorMiddleware",
  { error: RpcError },
) {}

export const PlakkApi = RpcGroup.make(Ping).middleware(InternalServerErrorMiddleware);
