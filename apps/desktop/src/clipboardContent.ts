import { Schema } from "effect";

export const ClipboardContentSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("image"),
    dataUrl: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("file"),
    name: Schema.String,
    extension: Schema.String,
    size: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("empty"),
  }),
]);

export type ClipboardContent = typeof ClipboardContentSchema.Type;
