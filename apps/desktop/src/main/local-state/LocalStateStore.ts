import { Context, type Effect } from "effect";

import type { CachedLocalStateSession, LocalStateError } from "./LocalState.ts";

export interface LocalStateStoreShape {
  readonly load: Effect.Effect<CachedLocalStateSession | null, LocalStateError>;
  readonly save: (session: CachedLocalStateSession | null) => Effect.Effect<void, LocalStateError>;
}

export class LocalStateStore extends Context.Service<LocalStateStore, LocalStateStoreShape>()(
  "plakk/main/local-state/LocalStateStore",
) {}
