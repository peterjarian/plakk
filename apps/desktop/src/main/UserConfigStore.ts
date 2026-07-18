import { Context, Data, type Effect } from "effect";

import type { UserConfig, UserConfigPatch } from "../ipc/contracts.ts";

export class UserConfigStoreError extends Data.TaggedError("UserConfigStoreError")<{
  readonly cause: unknown;
}> {}

export class UserConfigStore extends Context.Service<
  UserConfigStore,
  {
    readonly get: Effect.Effect<UserConfig, UserConfigStoreError>;
    set(patch: UserConfigPatch): Effect.Effect<UserConfig, UserConfigStoreError>;
    readonly reset: Effect.Effect<UserConfig, UserConfigStoreError>;
  }
>()("plakk/main/UserConfigStore") {}
