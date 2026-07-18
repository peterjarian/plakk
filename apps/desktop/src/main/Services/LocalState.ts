import { StorageProviderLiteral, UserSchema, type User } from "@plakk/shared";
import type { AccountStatus, PipeConnection } from "@plakk/shared/PlakkApi";
import { Context, Effect, Schema, type Stream } from "effect";

import type { DesktopSnippet, LocalState as LocalStateValue } from "../../ipc/contracts.ts";

export const CachedLocalStateSessionSchema = Schema.Struct({
  account: UserSchema,
  provider: Schema.Struct({
    known: Schema.Boolean,
    value: Schema.NullOr(StorageProviderLiteral),
  }),
  cleanupPending: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});

export type CachedLocalStateSession = typeof CachedLocalStateSessionSchema.Type;

export class LocalStateError extends Schema.TaggedErrorClass<LocalStateError>()("LocalStateError", {
  cause: Schema.Defect(),
  reason: Schema.String,
}) {}

export interface LocalStateStoreShape {
  readonly load: Effect.Effect<CachedLocalStateSession | null, LocalStateError>;
  readonly save: (session: CachedLocalStateSession | null) => Effect.Effect<void, LocalStateError>;
}

export class LocalStateStore extends Context.Service<LocalStateStore, LocalStateStoreShape>()(
  "plakk/main/Services/LocalStateStore",
) {}

export interface LocalStateSnippetsShape {
  readonly changes: Stream.Stream<string>;
  readonly read: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<DesktopSnippet>, LocalStateError>;
}

export class LocalStateSnippets extends Context.Service<
  LocalStateSnippets,
  LocalStateSnippetsShape
>()("plakk/main/Services/LocalStateSnippets") {}

export type LocalStateUpdate =
  | { readonly kind: "offline"; readonly account: User }
  | {
      readonly kind: "online";
      readonly account: User;
      readonly accountStatus: AccountStatus;
      readonly connection: PipeConnection | null;
    }
  | { readonly kind: "owner-cleanup-pending" }
  | { readonly kind: "signed-out" };

export interface LocalStateShape {
  readonly current: Effect.Effect<LocalStateValue>;
  readonly owner: Effect.Effect<{
    readonly account: User;
    readonly cleanupPending: boolean;
  } | null>;
  readonly changes: Stream.Stream<LocalStateValue>;
  readonly update: (update: LocalStateUpdate) => Effect.Effect<void, LocalStateError>;
  readonly refresh: Effect.Effect<void, LocalStateError>;
}

export class LocalState extends Context.Service<LocalState, LocalStateShape>()(
  "plakk/main/Services/LocalState",
) {}
