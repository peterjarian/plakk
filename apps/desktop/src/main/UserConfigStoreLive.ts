import ElectronStore from "electron-store";
import { Effect, Layer, Schema } from "effect";

import { UserConfigSchema, type UserConfig } from "../ipc/contracts.ts";
import { UserConfigStore, UserConfigStoreError } from "./UserConfigStore.ts";

const defaultUserConfig: UserConfig = {
  appearance: "system",
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

export const UserConfigStoreLive = Layer.effect(
  UserConfigStore,
  Effect.try({
    try: () => {
      const store = new ElectronStore<UserConfig>({
        name: "user-config",
        defaults: defaultUserConfig,
      });

      const get = readUserConfig(store);

      const set = Effect.fn("UserConfigStore.set")(function* (patch: Partial<UserConfig>) {
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
