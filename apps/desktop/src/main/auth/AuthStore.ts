import { UserSchema } from "@plakk/shared";
import { safeStorage } from "electron";
import ElectronStore from "electron-store";
import { Context, Effect, Layer, Schema } from "effect";

const CredentialsCodec = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String,
    organizationId: Schema.optionalKey(Schema.String),
    refreshToken: Schema.String,
    user: UserSchema,
  }),
);

const PkceCodec = Schema.fromJsonString(
  Schema.Struct({
    codeVerifier: Schema.String,
    expiresAt: Schema.Finite,
    state: Schema.String,
  }),
);

type AuthStoreKey = "credentials" | "pkce";
type Credentials = typeof CredentialsCodec.Type;
type Pkce = typeof PkceCodec.Type;
type AuthStoreValues = {
  credentials: Credentials;
  pkce: Pkce;
};

const AuthStoreCodecs: {
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
>()("plakk/main/auth/AuthStore") {
  static readonly Live = Layer.effect(
    AuthStore,
    Effect.gen(function* () {
      const store = yield* Effect.try({
        try: () =>
          new ElectronStore<Record<AuthStoreKey, string | null>>({
            clearInvalidConfig: true,
            defaults: {
              credentials: null,
              pkce: null,
            },
            name: "auth",
          }),
        catch: (cause) => new AuthStoreError({ cause, reason: "Could not open auth store." }),
      });

      const readEncryptedString = Effect.fn("AuthStore.readEncryptedString")(function* (
        key: AuthStoreKey,
      ) {
        const blob = yield* Effect.try({
          try: () => store.get(key),
          catch: (cause) => new AuthStoreError({ cause, reason: `Could not read auth ${key}.` }),
        });
        if (blob === null) return null;

        return yield* Effect.try({
          try: () => safeStorage.decryptString(Buffer.from(blob, "base64")),
          catch: (cause) => new AuthStoreError({ cause, reason: `Could not decrypt auth ${key}.` }),
        });
      });

      const writeEncryptedString = Effect.fn("AuthStore.writeEncryptedString")(function* (
        key: AuthStoreKey,
        value: string | null,
      ) {
        yield* Effect.try({
          try: () => {
            store.set(
              key,
              value === null ? null : safeStorage.encryptString(value).toString("base64"),
            );
          },
          catch: (cause) => new AuthStoreError({ cause, reason: `Could not write auth ${key}.` }),
        });
      });

      const decodeStoredValue = Effect.fn("AuthStore.decodeStoredValue")(function* <
        Key extends AuthStoreKey,
      >(key: Key, json: string): Effect.fn.Return<AuthStoreValues[Key], AuthStoreError> {
        const decoded = Schema.decodeEffect(AuthStoreCodecs[key])(json).pipe(
          Effect.mapError(
            (cause) => new AuthStoreError({ cause, reason: `Stored auth ${key} is invalid.` }),
          ),
          // TypeScript loses the key-to-codec relationship through indexed access.
        ) as Effect.Effect<AuthStoreValues[Key], AuthStoreError>;

        return yield* decoded;
      });

      const encodeStoredValue = Effect.fn("AuthStore.encodeStoredValue")(function* <
        Key extends AuthStoreKey,
      >(key: Key, value: AuthStoreValues[Key]): Effect.fn.Return<string, AuthStoreError> {
        return yield* Schema.encodeEffect(AuthStoreCodecs[key])(value).pipe(
          Effect.mapError(
            (cause) => new AuthStoreError({ cause, reason: `Stored auth ${key} is invalid.` }),
          ),
        );
      });

      const get = Effect.fn("AuthStore.get")(function* <Key extends AuthStoreKey>(
        key: Key,
      ): Effect.fn.Return<AuthStoreValues[Key] | null, AuthStoreError> {
        const json = yield* readEncryptedString(key);
        if (json === null) return null;

        return yield* decodeStoredValue(key, json);
      });

      const set = Effect.fn("AuthStore.set")(function* <Key extends AuthStoreKey>(
        key: Key,
        value: AuthStoreValues[Key] | null,
      ) {
        yield* writeEncryptedString(
          key,
          value === null ? null : yield* encodeStoredValue(key, value),
        );
      });

      return AuthStore.of({
        isEncryptionAvailable: Effect.sync(() => safeStorage.isEncryptionAvailable()),
        clear: Effect.try({
          try: () => store.clear(),
          catch: (cause) => new AuthStoreError({ cause, reason: "Could not clear auth store." }),
        }),
        get,
        set,
      });
    }),
  );
}
