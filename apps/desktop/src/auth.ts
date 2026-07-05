import { UserSchema } from "@plakk/shared";
import { Schema } from "effect";

export const AuthStatusSchema = Schema.Struct({
  user: Schema.NullOr(UserSchema),
});

export type AuthStatus = typeof AuthStatusSchema.Type;

export const AuthErrorSchema = Schema.Struct({
  message: Schema.String,
});

export type AuthError = typeof AuthErrorSchema.Type;
