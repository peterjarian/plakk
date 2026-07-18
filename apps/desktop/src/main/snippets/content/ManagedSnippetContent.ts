import type { ResolvedSnippetIngestPayload } from "../../../ipc/contracts.ts";
import { Context, type Effect, Schema, type Stream } from "effect";

export class ManagedSnippetContentError extends Schema.TaggedErrorClass<ManagedSnippetContentError>()(
  "ManagedSnippetContentError",
  { cause: Schema.Defect(), reason: Schema.String, retryable: Schema.Boolean },
) {}

export type ManagedTextValidation = "VALID" | "INVALID" | "NOT_FOUND";

export class ManagedSnippetContent extends Context.Service<
  ManagedSnippetContent,
  {
    ingest(
      accountId: string,
      input: ResolvedSnippetIngestPayload,
    ): Effect.Effect<string, ManagedSnippetContentError>;
    path(
      accountId: string,
      snippetId: string,
      byteSize: number,
    ): Effect.Effect<string, ManagedSnippetContentError>;
    available(
      accountId: string,
      snippetId: string,
      byteSize: number,
    ): Effect.Effect<boolean, ManagedSnippetContentError>;
    get(
      accountId: string,
      snippetId: string,
    ): Effect.Effect<Uint8Array | null, ManagedSnippetContentError>;
    getPrefix(
      accountId: string,
      snippetId: string,
      maxBytes: number,
    ): Effect.Effect<Uint8Array | null, ManagedSnippetContentError>;
    validateText(
      accountId: string,
      snippetId: string,
    ): Effect.Effect<ManagedTextValidation, ManagedSnippetContentError>;
    putStream<E>(
      accountId: string,
      snippetId: string,
      byteSize: number,
      source: Stream.Stream<Uint8Array, E>,
    ): Effect.Effect<void, E | ManagedSnippetContentError>;
    discard(accountId: string, snippetId: string): Effect.Effect<void, ManagedSnippetContentError>;
    invalidate(
      accountId: string,
      snippetIds: ReadonlyArray<string>,
    ): Effect.Effect<void, ManagedSnippetContentError>;
    purge(accountId: string): Effect.Effect<void, ManagedSnippetContentError>;
  }
>()("plakk/main/snippets/content/ManagedSnippetContent") {}
