import { SnippetUploadStatusLiteral, StorageProviderLiteral } from "@plakk/shared";
import { SnippetIdSchema } from "@plakk/shared/PlakkApi";
import ElectronStore from "electron-store";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";

export const SnippetUploadOutboxEntrySchema = Schema.Struct({
  id: SnippetIdSchema,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  mediaType: Schema.NullOr(Schema.String),
  storageProvider: StorageProviderLiteral,
  phase: Schema.Literals(["QUEUED", "UPLOADING", "FAILED", "UPLOADED"] as const),
  progress: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  storageObjectId: Schema.NullOr(Schema.String),
  authoritativeStatus: Schema.NullOr(SnippetUploadStatusLiteral),
  errorMessage: Schema.NullOr(Schema.String),
  canRetry: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export type SnippetUploadOutboxEntry = typeof SnippetUploadOutboxEntrySchema.Type;

const StoredOutboxCodec = Schema.fromJsonString(Schema.Array(SnippetUploadOutboxEntrySchema));

export class SnippetUploadOutboxError extends Schema.TaggedErrorClass<SnippetUploadOutboxError>()(
  "SnippetUploadOutboxError",
  {
    cause: Schema.Defect(),
    reason: Schema.String,
  },
) {}

export class SnippetUploadOutbox extends Context.Service<
  SnippetUploadOutbox,
  {
    list(
      accountId: string,
    ): Effect.Effect<ReadonlyArray<SnippetUploadOutboxEntry>, SnippetUploadOutboxError>;
    get(
      accountId: string,
      snippetId: string,
    ): Effect.Effect<SnippetUploadOutboxEntry | null, SnippetUploadOutboxError>;
    put(
      accountId: string,
      entry: SnippetUploadOutboxEntry,
    ): Effect.Effect<void, SnippetUploadOutboxError>;
    remove(accountId: string, snippetId: string): Effect.Effect<void, SnippetUploadOutboxError>;
    purge(accountId: string): Effect.Effect<void, SnippetUploadOutboxError>;
  }
>()("plakk/main/SnippetUploadOutbox") {
  static readonly Live = Layer.effect(
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
}
