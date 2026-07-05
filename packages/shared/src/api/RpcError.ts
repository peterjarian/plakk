import * as Schema from "effect/Schema";

export class RpcError extends Schema.TaggedErrorClass<RpcError>()("RpcError", {
  message: Schema.String,
}) {}
