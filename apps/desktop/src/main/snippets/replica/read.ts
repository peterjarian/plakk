import type { SnippetUploadStatus } from "@plakk/shared";
import { Effect } from "effect";

import { ManagedSnippetContent } from "../content/ManagedSnippetContent.ts";
import { SnippetReplica, SnippetReplicaError } from "./SnippetReplica.ts";

export const getReplicaItems = Effect.fn("DesktopSnippetReplica.items")(function* (
  accountId: string,
) {
  const replica = yield* SnippetReplica;
  return (yield* replica.get(accountId))?.items ?? [];
});

export const getReplicaSnippet = Effect.fn("DesktopSnippetReplica.snippet")(function* (
  accountId: string,
  snippetId: string,
) {
  const snippet = (yield* getReplicaItems(accountId)).find((item) => item.id === snippetId);
  if (snippet === undefined) {
    return yield* new SnippetReplicaError({ cause: null, reason: "Snippet was not found." });
  }
  return snippet;
});

export const getManagedSnippetBytes = Effect.fn("DesktopSnippetReplica.content")(function* (
  account: { readonly id: string },
  snippetId: string,
  knownSnippet?: {
    readonly id: string;
    readonly fileName: string;
    readonly byteSize: number;
    readonly uploadStatus: SnippetUploadStatus | null;
  },
) {
  const content = yield* ManagedSnippetContent;
  const snippet = knownSnippet ?? (yield* getReplicaSnippet(account.id, snippetId));
  const available = yield* content.available(account.id, snippetId, snippet.byteSize);
  if (!available) {
    yield* content.invalidate(account.id, [snippetId]);
    return yield* new SnippetReplicaError({
      cause: null,
      reason: "Download this snippet before using it on this device.",
    });
  }
  const cached = yield* content.get(account.id, snippetId);
  if (cached?.byteLength === snippet.byteSize) return { bytes: cached, snippet };
  yield* content.invalidate(account.id, [snippetId]);
  return yield* new SnippetReplicaError({
    cause: null,
    reason: "Download this snippet before using it on this device.",
  });
});
