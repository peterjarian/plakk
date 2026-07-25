import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const RpcErrorCodeSchema = Schema.Literals([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_SERVER_ERROR",
] as const);

export type RpcErrorCode = typeof RpcErrorCodeSchema.Type;

export class RpcError extends Schema.TaggedErrorClass<RpcError>()("RpcError", {
  code: RpcErrorCodeSchema,
  message: Schema.String,
  traceId: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("untraced"))),
}) {}
