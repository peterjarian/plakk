import { Schema } from "effect";

export const TrayDroppedItemSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("files"),
    paths: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
]);

export type TrayDroppedItem = typeof TrayDroppedItemSchema.Type;
