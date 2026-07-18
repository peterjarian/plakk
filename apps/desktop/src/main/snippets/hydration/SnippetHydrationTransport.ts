import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import type { SnippetSyncAccount } from "../replica/SnippetRemoteTransport.ts";
import { Context, type Stream } from "effect";

import type { SnippetHydrationError } from "./SnippetHydration.ts";

export interface SnippetHydrationTransportShape {
  readonly stream: (
    account: SnippetSyncAccount,
    snippet: ApiSnippet,
  ) => Stream.Stream<Uint8Array, SnippetHydrationError>;
}

export class SnippetHydrationTransport extends Context.Service<
  SnippetHydrationTransport,
  SnippetHydrationTransportShape
>()("plakk/main/snippets/hydration/SnippetHydrationTransport") {}
