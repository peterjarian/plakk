import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import type { ApiSnippet, SnippetChangePage } from "@plakk/shared/PlakkApi";

import { makePlakkClient, getSnippetCopyPayload } from "./accountStatus.ts";
import { downloadSnippetBytes } from "./clipboard.ts";

const StoredReplicaCodec = Schema.fromJsonString(SnippetReplicaStateSchema);
const StoredAccountCodec = Schema.fromJsonString(UserSchema);

const replicaError = (reason: string) => (cause: unknown) =>
  new SnippetReplicaError({ cause, reason });

export const SnippetReplicaLive = Layer.effect(
  SnippetReplica,
  Effect.gen(function* () {
    const store = yield* Effect.try({
      try: () =>
        new ElectronStore<Record<string, string>>({
          accessPropertiesByDotNotation: false,
          name: "snippet-replicas",
        }),
      catch: replicaError("Could not open the snippet replica."),
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
          catch: replicaError("Could not read the snippet replica."),
        });
        if (json === undefined) return null;
        return yield* Schema.decodeEffect(StoredReplicaCodec)(json).pipe(
          Effect.mapError(replicaError("Stored snippet replica is invalid.")),
        );
      }),
      commit: Effect.fn("DesktopSnippetReplica.commit")(function* (accountId, state) {
        const json = yield* Schema.encodeEffect(StoredReplicaCodec)(state).pipe(
          Effect.mapError(replicaError("Snippet replica is invalid.")),
        );
        yield* Effect.try({
          try: () => store.set(accountId, json),
          catch: replicaError("Could not commit the snippet replica."),
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
      catch: replicaError("Could not open the active snippet account."),
    });

    return ActiveSnippetAccount.of({
      get: Effect.try({
        try: () => store.get("active"),
        catch: replicaError("Could not read the active snippet account."),
      }).pipe(
        Effect.flatMap((json) =>
          json === null
            ? Effect.succeed(null)
            : Schema.decodeEffect(StoredAccountCodec)(json).pipe(
                Effect.mapError(replicaError("Stored active snippet account is invalid.")),
              ),
        ),
      ),
      set: Effect.fn("ActiveSnippetAccount.set")(function* (user) {
        const json =
          user === null
            ? null
            : yield* Schema.encodeEffect(StoredAccountCodec)(user).pipe(
                Effect.mapError(replicaError("Active snippet account is invalid.")),
              );
        yield* Effect.try({
          try: () => store.set("active", json),
          catch: replicaError("Could not save the active snippet account."),
        });
      }),
    });
  }),
);

const contentError = (reason: string) => (cause: unknown) =>
  new ManagedSnippetContentError({ cause, reason });

const isMissingFile = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

export const ManagedSnippetContentLive = Layer.succeed(
  ManagedSnippetContent,
  ManagedSnippetContent.of({
    get: Effect.fn("DesktopManagedSnippetContent.get")(function* (accountId, snippetId, revision) {
      const path = contentPath(accountId, snippetId, revision);
      return yield* Effect.tryPromise({
        try: () => readFile(path).then((bytes) => Uint8Array.from(bytes)),
        catch: contentError("Could not read managed snippet content."),
      }).pipe(
        Effect.catch((error) =>
          isMissingFile(error.cause) ? Effect.succeed(null) : Effect.fail(error),
        ),
      );
    }),
    put: Effect.fn("DesktopManagedSnippetContent.put")(
      function* (accountId, snippetId, revision, bytes) {
        const path = contentPath(accountId, snippetId, revision);
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, bytes);
          },
          catch: contentError("Could not write managed snippet content."),
        });
      },
    ),
    invalidate: Effect.fn("DesktopManagedSnippetContent.invalidate")(
      function* (accountId, snippetIds) {
        yield* Effect.forEach(
          snippetIds,
          (snippetId) =>
            Effect.tryPromise({
              try: () =>
                rm(contentDirectory(accountId, snippetId), { force: true, recursive: true }),
              catch: contentError("Could not invalidate managed snippet content."),
            }),
          { discard: true },
        );
      },
    ),
  }),
);

const contentDirectory = (accountId: string, snippetId: string) =>
  join(
    app.getPath("userData"),
    "snippet-content",
    Buffer.from(accountId).toString("base64url"),
    snippetId,
  );

const contentPath = (accountId: string, snippetId: string, revision: string) =>
  join(contentDirectory(accountId, snippetId), Buffer.from(revision).toString("base64url"));

const headers = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });
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
          headers: headers(account.accessToken),
        });
        return { cursor: snapshot.cursor, items: snapshot.items.map(durableSnippet) };
      }),
      pull: Effect.fn("DesktopSnippetRemote.pull")(function* (account, cursor) {
        const page: SnippetChangePage = yield* client.PullSnippetChanges(
          { cursor, limit: 100 },
          { headers: headers(account.accessToken) },
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
          .SubscribeSnippetChanges(undefined, { headers: headers(account.accessToken) })
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
