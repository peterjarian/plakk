import * as Schema from "effect/Schema";

export class RpcError extends Schema.ErrorClass<RpcError>("plakk/RpcError")({
  message: Schema.String,
}) {}
