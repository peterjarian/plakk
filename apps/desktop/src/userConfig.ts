import { Schema } from "effect";

export const UserConfigSchema = Schema.Struct({
  showExternalLinkWarning: Schema.Boolean,
});

export type UserConfig = typeof UserConfigSchema.Type;

export const UserConfigPatchSchema = Schema.Struct({
  showExternalLinkWarning: Schema.optionalKey(Schema.Boolean),
});

export type UserConfigPatch = typeof UserConfigPatchSchema.Type;

export const defaultUserConfig: UserConfig = {
  showExternalLinkWarning: true,
};
