import { Context, type Effect, type Stream } from "effect";

import type { DesktopSnippet } from "../../ipc/contracts.ts";
import type { LocalStateError } from "./LocalState.ts";

export interface LocalStateSnippetsShape {
  readonly changes: Stream.Stream<string>;
  readonly read: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<DesktopSnippet>, LocalStateError>;
  readonly storageUsageBytes: (accountId: string) => Effect.Effect<number, LocalStateError>;
}

export class LocalStateSnippets extends Context.Service<
  LocalStateSnippets,
  LocalStateSnippetsShape
>()("plakk/main/local-state/LocalStateSnippets") {}
