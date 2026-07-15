import { UserSchema, type User } from "@plakk/shared";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
  SnippetRemoteTransport,
  SnippetReplica,
  SnippetReplicaError,
  SnippetReplicaStateSchema,
  TextSnippetUploadError,
  TextSnippetUploadTransport,
  visibleSnippetItems,
  type SnippetReplicaState,
  type TextSnippetOutboxItem,
} from "@plakk/shared/SnippetReplica";
import { app } from "electron";
import ElectronStore from "electron-store";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { accountCanSync, type ApiSnippet, type SnippetChangePage } from "@plakk/shared/PlakkApi";

import { StorageUpload } from "../storageUpload.ts";
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
      readonly textOutbox: ReadonlyArray<TextSnippetOutboxItem>;
    }>();
    const persistencePermit = yield* Semaphore.make(1);

    const read = Effect.fn("DesktopSnippetReplica.read")(function* (accountId: string) {
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
    });

    return SnippetReplica.of({
      changes: Stream.fromPubSub(changes),
      get: Effect.fn("DesktopSnippetReplica.get")(function* (accountId) {
        return yield* persistencePermit.withPermit(read(accountId));
      }),
      modify: Effect.fn("DesktopSnippetReplica.modify")(function* (accountId, update) {
        return yield* persistencePermit.withPermit(
          Effect.gen(function* () {
            const state = update(yield* read(accountId));
            const json = yield* Schema.encodeEffect(StoredReplicaCodec)(state).pipe(
              Effect.mapError(
                (cause) =>
                  new SnippetReplicaError({ cause, reason: "Snippet replica is invalid." }),
              ),
            );
            yield* Effect.try({
              try: () => store.set(accountId, json),
              catch: (cause) =>
                new SnippetReplicaError({ cause, reason: "Could not commit the snippet replica." }),
            });
            yield* PubSub.publish(changes, {
              accountId,
              items: state.items,
              textOutbox: state.textOutbox ?? [],
            });
            return state;
          }),
        );
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
      removeRevision: Effect.fn("DesktopManagedSnippetContent.removeRevision")(
        function* (accountId, snippetId, revision) {
          yield* fileSystem
            .remove(contentPath(accountId, snippetId, revision), { force: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedSnippetContentError({
                    cause,
                    reason: "Could not invalidate managed snippet content revision.",
                  }),
              ),
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

export const TextSnippetUploadTransportLive = Layer.effect(
  TextSnippetUploadTransport,
  Effect.gen(function* () {
    const client = yield* makePlakkClient;
    const storage = yield* StorageUpload;
    const headers = (account: { readonly accessToken: string }) => ({
      authorization: `Bearer ${account.accessToken}`,
    });
    return TextSnippetUploadTransport.of({
      resolveStorageProvider: Effect.fn("DesktopTextSnippetUpload.resolveStorageProvider")(
        function* (account) {
          const status = yield* client.GetAccountStatus(undefined, { headers: headers(account) });
          if (!accountCanSync(status) || status.storageProvider === null) {
            return yield* new TextSnippetUploadError({
              actionable: true,
              message: "Finish account or storage setup before this snippet can sync.",
            });
          }
          return status.storageProvider;
        },
      ),
      create: Effect.fn("DesktopTextSnippetUpload.create")(function* (account, item) {
        return yield* client.CreateStoredSnippet(
          {
            id: item.snippetId,
            mutationId: item.mutationId,
            kind: "TEXT",
            byteSize: item.byteSize,
            storageProvider: item.storageProvider,
            storageObjectId: null,
          },
          { headers: headers(account) },
        );
      }),
      prepare: Effect.fn("DesktopTextSnippetUpload.prepare")(function* (account, item) {
        return yield* client.PrepareStoredSnippetUpload(
          {
            snippetId: item.snippetId,
            storageProvider: item.storageProvider,
            mutationId: item.mutationId,
            ...(item.replacePreparationGeneration === null ||
            item.replacePreparationGeneration === undefined
              ? {}
              : { replacePreparationGeneration: item.replacePreparationGeneration }),
          },
          { headers: headers(account) },
        );
      }),
      heartbeat: Effect.fn("DesktopTextSnippetUpload.heartbeat")(function* (account, item) {
        yield* client.HeartbeatStoredSnippetUpload(
          { id: item.snippetId, mutationId: item.mutationId },
          { headers: headers(account) },
        );
      }),
      upload: Effect.fn("DesktopTextSnippetUpload.upload")(
        function* (item, bytes, prepared) {
          const result = yield* storage.upload(
            { id: item.snippetId, byteSize: item.byteSize, bytes, prepared },
            () => undefined,
          );
          return result.storageObjectId;
        },
        Effect.mapError(
          (cause) =>
            new TextSnippetUploadError({
              actionable: cause.actionable,
              cause,
              message: cause.message,
              ...(cause.stalePreparation ? { stalePreparation: true } : {}),
            }),
        ),
      ),
      complete: Effect.fn("DesktopTextSnippetUpload.complete")(
        function* (account, item, storageObjectId) {
          return durableSnippet(
            yield* client.UpdateStoredSnippetUploadStatus(
              {
                id: item.snippetId,
                uploadStatus: "READY",
                mutationId: item.mutationId,
                storageObjectId,
              },
              { headers: headers(account) },
            ),
          );
        },
      ),
      fail: Effect.fn("DesktopTextSnippetUpload.fail")(function* (account, item, message) {
        yield* client.UpdateStoredSnippetUploadStatus(
          {
            id: item.snippetId,
            uploadStatus: "FAILED",
            mutationId: item.mutationId,
            errorMessage: message,
          },
          { headers: headers(account) },
        );
      }),
    });
  }),
);

export const getReplicaItems = Effect.fn("DesktopSnippetReplica.items")(function* (
  accountId: string,
) {
  const replica = yield* SnippetReplica;
  return (yield* replica.get(accountId))?.items ?? [];
});

export const getVisibleReplicaItems = Effect.fn("DesktopSnippetReplica.visibleItems")(function* (
  accountId: string,
) {
  const replica = yield* SnippetReplica;
  return visibleSnippetItems(yield* replica.get(accountId));
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
  const replica = yield* SnippetReplica;
  const state = yield* replica.get(account.id);
  const queued = state?.textOutbox?.find((item) => item.snippetId === snippetId);
  if (queued !== undefined) {
    const bytes = yield* content.get(account.id, queued.snippetId, queued.mutationId);
    if (bytes === null || bytes.byteLength !== queued.byteSize) {
      return yield* new SnippetReplicaError({
        cause: null,
        reason: "Queued snippet content is not available.",
      });
    }
    const snippet = visibleSnippetItems(state).find((item) => item.id === snippetId)!;
    return { bytes, snippet };
  }
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
