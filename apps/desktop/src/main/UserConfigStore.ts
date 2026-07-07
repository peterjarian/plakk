import ElectronStore from "electron-store";
import { Context, Data, Effect, Layer, Schema } from "effect";

export class UserConfigStoreError extends Data.TaggedError("UserConfigStoreError")<{
  readonly cause: unknown;
}> {}

const UserConfigSchema = Schema.Struct({
  showExternalLinkWarning: Schema.Boolean,
});

type UserConfig = typeof UserConfigSchema.Type;

type UserConfigPatch = Partial<UserConfig>;

const defaultUserConfig: UserConfig = {
  showExternalLinkWarning: true,
};

const decodeUserConfig = (input: unknown) =>
  Schema.decodeUnknownEffect(UserConfigSchema)(input).pipe(
    Effect.mapError((cause) => new UserConfigStoreError({ cause })),
  );

const readUserConfig = (store: ElectronStore<UserConfig>) =>
  Effect.try({
    try: () => ({ ...defaultUserConfig, ...store.store }),
    catch: (cause) => new UserConfigStoreError({ cause }),
  }).pipe(Effect.flatMap(decodeUserConfig));

export class UserConfigStore extends Context.Service<
  UserConfigStore,
  {
    readonly get: Effect.Effect<UserConfig, UserConfigStoreError>;
    set(patch: UserConfigPatch): Effect.Effect<UserConfig, UserConfigStoreError>;
    readonly reset: Effect.Effect<UserConfig, UserConfigStoreError>;
  }
>()("plakk/main/UserConfigStore") {
  static readonly Live = Layer.effect(
    UserConfigStore,
    Effect.try({
      try: () => {
        const store = new ElectronStore<UserConfig>({
          name: "user-config",
          defaults: defaultUserConfig,
        });

        const get = readUserConfig(store);

        const set = Effect.fn("UserConfigStore.set")(function* (patch: UserConfigPatch) {
          const config = yield* decodeUserConfig({ ...(yield* get), ...patch });

          yield* Effect.try({
            try: () => {
              store.store = config;
            },
            catch: (cause) => new UserConfigStoreError({ cause }),
          });

          return config;
        });

        const reset = Effect.try({
          try: () => {
            store.store = defaultUserConfig;
            return defaultUserConfig;
          },
          catch: (cause) => new UserConfigStoreError({ cause }),
        });

        return UserConfigStore.of({ get, reset, set });
      },
      catch: (cause) => new UserConfigStoreError({ cause }),
    }),
  );
}
