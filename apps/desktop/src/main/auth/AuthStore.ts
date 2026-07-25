import { UserSchema } from "@plakk/shared";
import { Context, type Effect, Schema } from "effect";

export const CredentialsCodec = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String,
    organizationId: Schema.optionalKey(Schema.String),
    refreshToken: Schema.String,
    user: UserSchema,
  }),
);

export const PkceCodec = Schema.fromJsonString(
  Schema.Struct({
    codeVerifier: Schema.String,
    expiresAt: Schema.Finite,
    state: Schema.String,
  }),
);

export type AuthStoreKey = "credentials" | "pkce";
export type AuthStoreValues = {
  credentials: typeof CredentialsCodec.Type;
  pkce: typeof PkceCodec.Type;
};

export const AuthStoreCodecs: {
  [Key in AuthStoreKey]: Schema.ConstraintCodec<AuthStoreValues[Key], string>;
} = {
  credentials: CredentialsCodec,
  pkce: PkceCodec,
};

export class AuthStoreError extends Schema.TaggedErrorClass<AuthStoreError>()("AuthStoreError", {
  cause: Schema.Defect(),
  reason: Schema.String,
}) {}

export class AuthStore extends Context.Service<
  AuthStore,
  {
    readonly isEncryptionAvailable: Effect.Effect<boolean>;
    readonly clear: Effect.Effect<void, AuthStoreError>;
    get<Key extends AuthStoreKey>(
      key: Key,
    ): Effect.Effect<AuthStoreValues[Key] | null, AuthStoreError>;
    set<Key extends AuthStoreKey>(
      key: Key,
      value: AuthStoreValues[Key] | null,
    ): Effect.Effect<void, AuthStoreError>;
  }
>()("plakk/main/auth/AuthStore") {}
