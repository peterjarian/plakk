import { UserSchema, type User } from "@plakk/shared";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
  SnippetRemoteTransport,
  SnippetReplica,
  SnippetReplicaError,
  SnippetReplicaStateSchema,
  type SnippetReplicaState,
} from "@plakk/shared/SnippetReplica";
import { app } from "electron";
import ElectronStore from "electron-store";
import { Context, Effect, FileSystem, Layer, Path, PubSub, Schema, Stream } from "effect";
import type { ApiSnippet, SnippetChangePage } from "@plakk/shared/PlakkApi";

import { makePlakkClient, getSnippetCopyPayload } from "./accountStatus.ts";
import { downloadSnippetBytes } from "./clipboard.ts";

const StoredReplicaCodec = Schema.fromJsonString(SnippetReplicaStateSchema);
const StoredAccountCodec = Schema.fromJsonString(UserSchema);

export const SnippetReplicaLive = Layer.effect(
  SnippetReplica,
  Effect.gen(function* () {
    const store = yield* Effect.try({
      try: () =>
        new ElectronStore<Record<string, string>>({
          accessPropertiesByDotNotation: false,
          name: "snippet-replicas",
        }),
      catch: (cause) =>
        new SnippetReplicaError({ cause, reason: "Could not open the snippet replica." }),
    });
    const changes = yield* PubSub.unbounded<{
      readonly accountId: string;
      readonly items: SnippetReplicaState["items"];
    }>();

    return SnippetReplica.of({
      changes: Stream.fromPubSub(changes),
      get: Effect.fn("DesktopSnippetReplica.get")(function* (accountId: string) {
        const json = yield* Effect.try({
          try: () => store.get(accountId),
          catch: (cause) =>
            new SnippetReplicaError({ cause, reason: "Could not read the snippet replica." }),
        });
        if (json === undefined) return null;
        return yield* Schema.decodeEffect(StoredReplicaCodec)(json).pipe(
          Effect.mapError(
            (cause) =>
              new SnippetReplicaError({
                cause,
                reason: "Stored snippet replica is invalid.",
              }),
          ),
        );
      }),
      commit: Effect.fn("DesktopSnippetReplica.commit")(function* (accountId, state) {
        const json = yield* Schema.encodeEffect(StoredReplicaCodec)(state).pipe(
          Effect.mapError(
            (cause) => new SnippetReplicaError({ cause, reason: "Snippet replica is invalid." }),
          ),
        );
        yield* Effect.try({
          try: () => store.set(accountId, json),
          catch: (cause) =>
            new SnippetReplicaError({ cause, reason: "Could not commit the snippet replica." }),
        });
        yield* PubSub.publish(changes, { accountId, items: state.items });
      }),
    });
  }),
);

export class ActiveSnippetAccount extends Context.Service<
  ActiveSnippetAccount,
  {
    readonly get: Effect.Effect<User | null, SnippetReplicaError>;
    set(user: User | null): Effect.Effect<void, SnippetReplicaError>;
  }
>()("plakk/main/ActiveSnippetAccount") {}

export const ActiveSnippetAccountLive = Layer.effect(
  ActiveSnippetAccount,
  Effect.gen(function* () {
    const store = yield* Effect.try({
      try: () =>
        new ElectronStore<{ active: string | null }>({
          defaults: { active: null },
          name: "snippet-replica-account",
        }),
      catch: (cause) =>
        new SnippetReplicaError({
          cause,
          reason: "Could not open the active snippet account.",
        }),
    });

    return ActiveSnippetAccount.of({
      get: Effect.try({
        try: () => store.get("active"),
        catch: (cause) =>
          new SnippetReplicaError({
            cause,
            reason: "Could not read the active snippet account.",
          }),
      }).pipe(
        Effect.flatMap((json) =>
          json === null
            ? Effect.succeed(null)
            : Schema.decodeEffect(StoredAccountCodec)(json).pipe(
                Effect.mapError(
                  (cause) =>
                    new SnippetReplicaError({
                      cause,
                      reason: "Stored active snippet account is invalid.",
                    }),
                ),
              ),
        ),
      ),
      set: Effect.fn("ActiveSnippetAccount.set")(function* (user) {
        const json =
          user === null
            ? null
            : yield* Schema.encodeEffect(StoredAccountCodec)(user).pipe(
                Effect.mapError(
                  (cause) =>
                    new SnippetReplicaError({
                      cause,
                      reason: "Active snippet account is invalid.",
                    }),
                ),
              );
        yield* Effect.try({
          try: () => store.set("active", json),
          catch: (cause) =>
            new SnippetReplicaError({
              cause,
              reason: "Could not save the active snippet account.",
            }),
        });
      }),
    });
  }),
);

export const ManagedSnippetContentLive = Layer.effect(
  ManagedSnippetContent,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const contentDirectory = (accountId: string, snippetId: string) =>
      path.join(
        app.getPath("userData"),
        "snippet-content",
        Buffer.from(accountId).toString("base64url"),
        snippetId,
      );
    const contentPath = (accountId: string, snippetId: string, revision: string) =>
      path.join(
        contentDirectory(accountId, snippetId),
        Buffer.from(revision).toString("base64url"),
      );

    return ManagedSnippetContent.of({
      get: Effect.fn("DesktopManagedSnippetContent.get")(
        function* (accountId, snippetId, revision) {
          return yield* fileSystem.readFile(contentPath(accountId, snippetId, revision)).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
            Effect.mapError(
              (cause) =>
                new ManagedSnippetContentError({
                  cause,
                  reason: "Could not read managed snippet content.",
                }),
            ),
          );
        },
      ),
      put: Effect.fn("DesktopManagedSnippetContent.put")(
        function* (accountId, snippetId, revision, bytes) {
          const filePath = contentPath(accountId, snippetId, revision);
          yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedSnippetContentError({
                  cause,
                  reason: "Could not prepare managed snippet content.",
                }),
            ),
          );
          yield* fileSystem.writeFile(filePath, bytes).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedSnippetContentError({
                  cause,
                  reason: "Could not write managed snippet content.",
                }),
            ),
          );
        },
      ),
      invalidate: Effect.fn("DesktopManagedSnippetContent.invalidate")(
        function* (accountId, snippetIds) {
          yield* Effect.forEach(
            snippetIds,
            (snippetId) =>
              fileSystem
                .remove(contentDirectory(accountId, snippetId), { force: true, recursive: true })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedSnippetContentError({
                        cause,
                        reason: "Could not invalidate managed snippet content.",
                      }),
                  ),
                ),
            { discard: true },
          );
        },
      ),
    });
  }),
);
const durableSnippet = (snippet: ApiSnippet): ApiSnippet => ({
  ...snippet,
  contentUrl: null,
  thumbnailUrl: null,
});

export const SnippetRemoteTransportLive = Layer.effect(
  SnippetRemoteTransport,
  Effect.gen(function* () {
    const client = yield* makePlakkClient;
    return SnippetRemoteTransport.of({
      snapshot: Effect.fn("DesktopSnippetRemote.snapshot")(function* (account) {
        const snapshot = yield* client.GetSnippetSnapshot(undefined, {
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
        return { cursor: snapshot.cursor, items: snapshot.items.map(durableSnippet) };
      }),
      pull: Effect.fn("DesktopSnippetRemote.pull")(function* (account, cursor) {
        const page: SnippetChangePage = yield* client.PullSnippetChanges(
          { cursor, limit: 100 },
          { headers: { authorization: `Bearer ${account.accessToken}` } },
        );
        return page.status === "RESNAPSHOT_REQUIRED"
          ? page
          : {
              ...page,
              changes: page.changes.map((change) =>
                change.type === "UPSERT"
                  ? { ...change, snippet: durableSnippet(change.snippet) }
                  : change,
              ),
            };
      }),
      wakes: (account) =>
        client
          .SubscribeSnippetChanges(undefined, {
            headers: { authorization: `Bearer ${account.accessToken}` },
          })
          .pipe(Stream.map(() => undefined)),
    });
  }),
);

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
  account: { readonly id: string; readonly accessToken: string | null },
  snippetId: string,
) {
  const content = yield* ManagedSnippetContent;
  const snippet = yield* getReplicaSnippet(account.id, snippetId);
  const cached = yield* content.get(account.id, snippetId, snippet.updatedAt);
  if (cached?.byteLength === snippet.byteSize) return { bytes: cached, snippet };
  if (cached !== null) yield* content.invalidate(account.id, [snippetId]);

  const bytes =
    snippet.kind === "TEXT" && snippet.textContent !== null
      ? new TextEncoder().encode(snippet.textContent)
      : account.accessToken === null
        ? yield* new SnippetReplicaError({
            cause: null,
            reason: "Snippet content is not available offline yet.",
          })
        : yield* downloadSnippetBytes(yield* getSnippetCopyPayload(account.accessToken, snippetId));
  if (bytes.byteLength !== snippet.byteSize) {
    return yield* new SnippetReplicaError({
      cause: null,
      reason: "Snippet content does not match its metadata.",
    });
  }
  yield* content.put(account.id, snippetId, snippet.updatedAt, bytes);
  return { bytes, snippet };
});
