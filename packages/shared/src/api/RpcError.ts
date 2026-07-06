import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const RpcErrorCodeSchema = Schema.Literal("INTERNAL_SERVER_ERROR");

export type RpcErrorCode = typeof RpcErrorCodeSchema.Type;

export class RpcError extends Schema.TaggedErrorClass<RpcError>()("RpcError", {
  code: RpcErrorCodeSchema,
  message: Schema.String,
  traceId: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("untraced"))),
}) {}
