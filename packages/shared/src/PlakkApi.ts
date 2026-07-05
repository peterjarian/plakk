import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

export const PingResult = Schema.Struct({
  ok: Schema.Boolean,
});

export type PingResult = typeof PingResult.Type;

class Ping extends Rpc.make("Ping", {
  success: PingResult,
}) {}

export const PlakkApi = RpcGroup.make(Ping);
