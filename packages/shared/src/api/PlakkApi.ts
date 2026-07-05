import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

export const PingResultSchema = Schema.Struct({
  ok: Schema.Boolean,
});

export type PingResult = typeof PingResultSchema.Type;

class Ping extends Rpc.make("Ping", {
  success: PingResultSchema,
}) {}

export const PlakkApi = RpcGroup.make(Ping);
