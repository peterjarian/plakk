import ElectronStore from "electron-store";
import { Effect, Layer, Schema, Semaphore } from "effect";
import {
  SnippetUploadOutbox,
  SnippetUploadOutboxEntrySchema,
  SnippetUploadOutboxError,
  type SnippetUploadOutboxEntry,
} from "./SnippetUploadOutbox.ts";

const StoredOutboxCodec = Schema.fromJsonString(Schema.Array(SnippetUploadOutboxEntrySchema));

export const SnippetUploadOutboxLive = Layer.effect(
  SnippetUploadOutbox,
  Effect.gen(function* () {
    const store = yield* Effect.try({
      try: () =>
        new ElectronStore<Record<string, string>>({
          accessPropertiesByDotNotation: false,
          name: "snippet-upload-outboxes",
        }),
      catch: (cause) =>
        new SnippetUploadOutboxError({ cause, reason: "Could not open the upload outbox." }),
    });
    const lock = yield* Semaphore.make(1);

    const readUnlocked = Effect.fn("SnippetUploadOutbox.read")(function* (accountId: string) {
      const json = yield* Effect.try({
        try: () => store.get(accountId),
        catch: (cause) =>
          new SnippetUploadOutboxError({ cause, reason: "Could not read the upload outbox." }),
      });
      if (json === undefined) return [];
      return yield* Schema.decodeEffect(StoredOutboxCodec)(json).pipe(
        Effect.mapError(
          (cause) =>
            new SnippetUploadOutboxError({
              cause,
              reason: "Stored upload work is invalid.",
            }),
        ),
      );
    });

    const writeUnlocked = Effect.fn("SnippetUploadOutbox.write")(function* (
      accountId: string,
      entries: ReadonlyArray<SnippetUploadOutboxEntry>,
    ) {
      const json = yield* Schema.encodeEffect(StoredOutboxCodec)(entries).pipe(
        Effect.mapError(
          (cause) => new SnippetUploadOutboxError({ cause, reason: "Upload work is invalid." }),
        ),
      );
      yield* Effect.try({
        try: () => store.set(accountId, json),
        catch: (cause) =>
          new SnippetUploadOutboxError({ cause, reason: "Could not save upload work." }),
      });
    });

    const list = Effect.fn("SnippetUploadOutbox.list")((accountId: string) =>
      lock.withPermit(readUnlocked(accountId)),
    );
    const get = Effect.fn("SnippetUploadOutbox.get")(function* (
      accountId: string,
      snippetId: string,
    ) {
      return (yield* list(accountId)).find((entry) => entry.id === snippetId) ?? null;
    });
    const put = Effect.fn("SnippetUploadOutbox.put")((accountId, entry) =>
      lock.withPermit(
        Effect.gen(function* () {
          const entries = yield* readUnlocked(accountId);
          yield* writeUnlocked(
            accountId,
            entries.some((current) => current.id === entry.id)
              ? entries.map((current) => (current.id === entry.id ? entry : current))
              : [entry, ...entries],
          );
        }),
      ),
    );
    const remove = Effect.fn("SnippetUploadOutbox.remove")((accountId, snippetId) =>
      lock.withPermit(
        Effect.gen(function* () {
          const entries = yield* readUnlocked(accountId);
          yield* writeUnlocked(
            accountId,
            entries.filter((entry) => entry.id !== snippetId),
          );
        }),
      ),
    );
    const purge = Effect.fn("SnippetUploadOutbox.purge")((accountId: string) =>
      lock.withPermit(
        Effect.try({
          try: () => store.delete(accountId),
          catch: (cause) =>
            new SnippetUploadOutboxError({ cause, reason: "Could not purge upload recovery." }),
        }),
      ),
    );

    return SnippetUploadOutbox.of({ get, list, purge, put, remove });
  }),
);
