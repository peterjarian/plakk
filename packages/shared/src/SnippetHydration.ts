import {
  Context,
  DateTime,
  Effect,
  FiberMap,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import type { ApiSnippet } from "./api/PlakkApi.ts";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
  SnippetReplica,
  SnippetReplicaError,
  type SnippetSyncAccount,
} from "./SnippetReplica.ts";

export const SMART_RECENT_WINDOW_MILLIS = 7 * 24 * 60 * 60 * 1000;
export const SMART_RECENT_MAX_BYTES = 1024 * 1024 * 1024;
export const SMART_OLDER_MAX_BYTES = 20 * 1024 * 1024;

export const shouldHydrateAutomatically = (
  snippet: { readonly byteSize: number; readonly createdAt: string },
  nowEpochMillis: number,
  keepAllFilesOffline: boolean,
): boolean => {
  if (keepAllFilesOffline) return true;
  const createdAt = DateTime.make(snippet.createdAt);
  const age = Option.match(createdAt, {
    onNone: () => Number.POSITIVE_INFINITY,
    onSome: (value) => Math.max(0, nowEpochMillis - DateTime.toEpochMillis(value)),
  });
  return age <= SMART_RECENT_WINDOW_MILLIS
    ? snippet.byteSize <= SMART_RECENT_MAX_BYTES
    : snippet.byteSize <= SMART_OLDER_MAX_BYTES;
};

export class SnippetHydrationError extends Schema.TaggedErrorClass<SnippetHydrationError>()(
  "SnippetHydrationError",
  {
    cause: Schema.Defect(),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export class SnippetHydrationTransport extends Context.Service<
  SnippetHydrationTransport,
  {
    stream(
      account: SnippetSyncAccount,
      snippet: ApiSnippet,
    ): Stream.Stream<Uint8Array, SnippetHydrationError>;
  }
>()("@plakk/shared/SnippetHydration/SnippetHydrationTransport") {}

export const LocalContentAvailabilitySchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("AVAILABLE") }),
  Schema.Struct({ status: Schema.Literal("NOT_AVAILABLE") }),
  Schema.Struct({ status: Schema.Literal("DOWNLOADING") }),
  Schema.Struct({ status: Schema.Literal("FAILED"), message: Schema.String }),
]);

export type LocalContentAvailability = typeof LocalContentAvailabilitySchema.Type;

type HydrationSettings = { readonly keepAllFilesOffline: boolean };

export type SnippetHydrationEngineFailure =
  | SnippetHydrationError
  | ManagedSnippetContentError
  | SnippetReplicaError;

const presentHydrationFailure = (cause: SnippetHydrationEngineFailure): SnippetHydrationError =>
  cause._tag === "SnippetHydrationError"
    ? cause
    : new SnippetHydrationError({
        cause,
        reason: cause.reason,
        retryable: cause._tag === "ManagedSnippetContentError" ? cause.retryable : true,
      });

export class SnippetHydrationEngine extends Context.Service<
  SnippetHydrationEngine,
  {
    readonly changes: Stream.Stream<string>;
    resume(
      account: SnippetSyncAccount,
      settings: HydrationSettings,
    ): Effect.Effect<void, SnippetHydrationEngineFailure>;
    updateSettings(settings: HydrationSettings): Effect.Effect<void, SnippetHydrationEngineFailure>;
    readonly pause: Effect.Effect<void>;
    purge(accountId: string): Effect.Effect<void>;
    reconcile(
      accountId: string,
    ): Effect.Effect<ReadonlyMap<string, LocalContentAvailability>, SnippetHydrationEngineFailure>;
    download(
      account: SnippetSyncAccount,
      snippetId: string,
    ): Effect.Effect<void, SnippetHydrationEngineFailure>;
    state(
      accountId: string,
      snippetId: string,
      byteSize: number,
    ): Effect.Effect<LocalContentAvailability, ManagedSnippetContentError>;
  }
>()("@plakk/shared/SnippetHydration/SnippetHydrationEngine") {
  static readonly Live = Layer.effect(
    SnippetHydrationEngine,
    Effect.gen(function* () {
      const content = yield* ManagedSnippetContent;
      const replica = yield* SnippetReplica;
      const transport = yield* SnippetHydrationTransport;
      const changes = yield* PubSub.unbounded<string>();
      const currentAccount = yield* Ref.make<SnippetSyncAccount | null>(null);
      const settings = yield* Ref.make<HydrationSettings>({ keepAllFilesOffline: false });
      const concurrency = yield* Semaphore.make(2);
      const fibers = yield* FiberMap.make<string>();
      const active = new Set<string>();
      const failures = new Map<string, SnippetHydrationError>();
      const retryKey = "@plakk/snippet-hydration/retry";

      const key = (accountId: string, snippetId: string) => `${accountId}/${snippetId}`;
      const publish = (accountId: string) => PubSub.publish(changes, accountId);
      const stateWithoutValidation = (hydrationKey: string): LocalContentAvailability => {
        if (active.has(hydrationKey)) return { status: "DOWNLOADING" };
        const failure = failures.get(hydrationKey);
        return failure === undefined
          ? { status: "NOT_AVAILABLE" }
          : { status: "FAILED", message: failure.reason };
      };

      const currentSnippet = Effect.fn("SnippetHydrationEngine.currentSnippet")(function* (
        accountId: string,
        snippetId: string,
      ) {
        const state = yield* replica.get(accountId);
        return state?.items.find((snippet) => snippet.id === snippetId) ?? null;
      });

      const hydrate = Effect.fn("SnippetHydrationEngine.hydrate")(function* (
        account: SnippetSyncAccount,
        snippet: ApiSnippet,
      ) {
        const hydrationKey = key(account.id, snippet.id);
        yield* content
          .putStream(account.id, snippet.id, snippet.byteSize, transport.stream(account, snippet))
          .pipe(
            Effect.retry({
              schedule: Schedule.exponential("1 second"),
              times: 2,
              while: (error) =>
                error._tag === "SnippetHydrationError" ||
                error._tag === "ManagedSnippetContentError"
                  ? error.retryable
                  : true,
            }),
          );

        const latest = yield* currentSnippet(account.id, snippet.id);
        if (latest === null || latest.uploadStatus !== "UPLOADED") {
          yield* content.invalidate(account.id, [snippet.id]);
          return;
        }
        failures.delete(hydrationKey);
      });

      const startHydration = Effect.fn("SnippetHydrationEngine.startHydration")(function* (
        account: SnippetSyncAccount,
        snippet: ApiSnippet,
        invalidateFirst = false,
      ) {
        const hydrationKey = key(account.id, snippet.id);
        if (active.has(hydrationKey)) return;
        active.add(hydrationKey);
        failures.delete(hydrationKey);

        const work = Effect.gen(function* () {
          yield* Effect.yieldNow;
          yield* publish(account.id);
          if (invalidateFirst) yield* content.invalidate(account.id, [snippet.id]);
          yield* concurrency.withPermit(hydrate(account, snippet)).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                failures.set(hydrationKey, presentHydrationFailure(error));
              }),
            ),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active.delete(hydrationKey);
            }).pipe(Effect.andThen(publish(account.id))),
          ),
        );
        yield* FiberMap.run(fibers, hydrationKey, work);
      });

      const reconcile = Effect.fn("SnippetHydrationEngine.reconcile")(function* (
        accountId: string,
        retryFailed: "none" | "retryable" | "all" = "none",
      ) {
        const account = yield* Ref.get(currentAccount);
        if (account?.id !== accountId) return new Map<string, LocalContentAvailability>();
        const state = yield* replica.get(accountId);
        const uploaded = (state?.items ?? []).filter(
          (snippet) => snippet.uploadStatus === "UPLOADED",
        );
        const uploadedKeys = new Set(uploaded.map((snippet) => key(accountId, snippet.id)));

        yield* Effect.forEach(
          [...active].filter(
            (hydrationKey) =>
              hydrationKey.startsWith(`${accountId}/`) && !uploadedKeys.has(hydrationKey),
          ),
          (hydrationKey) =>
            FiberMap.remove(fibers, hydrationKey).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  active.delete(hydrationKey);
                  failures.delete(hydrationKey);
                }),
              ),
            ),
          { discard: true },
        );

        const retention = yield* Ref.get(settings);
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const availability = yield* Effect.forEach(
          uploaded,
          (snippet) => {
            const inspect = Effect.gen(function* () {
              const hydrationKey = key(accountId, snippet.id);
              if (active.has(hydrationKey)) {
                return [snippet.id, stateWithoutValidation(hydrationKey)] as const;
              }
              const available = yield* content.available(accountId, snippet.id, snippet.byteSize);
              if (available) {
                failures.delete(hydrationKey);
                return [snippet.id, { status: "AVAILABLE" } as const] as const;
              }
              yield* content.invalidate(accountId, [snippet.id]);
              const failure = failures.get(hydrationKey);
              const canRetryFailure =
                failure === undefined ||
                retryFailed === "all" ||
                (retryFailed === "retryable" && failure.retryable);
              if (
                shouldHydrateAutomatically(snippet, now, retention.keepAllFilesOffline) &&
                canRetryFailure
              ) {
                yield* startHydration(account, snippet);
              }
              return [snippet.id, stateWithoutValidation(hydrationKey)] as const;
            });
            return inspect.pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  const failure = presentHydrationFailure(error);
                  failures.set(key(accountId, snippet.id), failure);
                  return [
                    snippet.id,
                    { status: "FAILED", message: failure.reason } as const,
                  ] as const;
                }),
              ),
            );
          },
          { concurrency: 2 },
        );
        return new Map(availability);
      });

      const pause = Effect.gen(function* () {
        yield* Ref.set(currentAccount, null);
        active.clear();
        yield* FiberMap.clear(fibers);
      });

      const purge = Effect.fn("SnippetHydrationEngine.purge")(function* (accountId: string) {
        const account = yield* Ref.get(currentAccount);
        if (account?.id === accountId) yield* pause;
        const prefix = `${accountId}/`;
        for (const hydrationKey of failures.keys()) {
          if (hydrationKey.startsWith(prefix)) failures.delete(hydrationKey);
        }
        yield* publish(accountId);
      });

      const resume = Effect.fn("SnippetHydrationEngine.resume")(function* (
        account: SnippetSyncAccount,
        nextSettings: HydrationSettings,
      ) {
        const previous = yield* Ref.get(currentAccount);
        if (
          previous !== null &&
          (previous.id !== account.id || previous.accessToken !== account.accessToken)
        ) {
          yield* pause;
        }
        yield* Ref.set(currentAccount, account);
        yield* Ref.set(settings, nextSettings);
        yield* reconcile(account.id, "all");
        if (!FiberMap.hasUnsafe(fibers, retryKey)) {
          yield* FiberMap.run(
            fibers,
            retryKey,
            Effect.sleep("5 minutes").pipe(
              Effect.andThen(
                Ref.get(currentAccount).pipe(
                  Effect.flatMap((activeAccount) =>
                    activeAccount === null ? Effect.void : reconcile(activeAccount.id, "retryable"),
                  ),
                ),
              ),
              Effect.catch((error) =>
                Effect.logWarning("Could not retry snippet hydration", { error }),
              ),
              Effect.forever,
            ),
          );
        }
      });

      const updateSettings = Effect.fn("SnippetHydrationEngine.updateSettings")(function* (
        nextSettings: HydrationSettings,
      ) {
        yield* Ref.set(settings, nextSettings);
        const account = yield* Ref.get(currentAccount);
        if (account !== null) yield* reconcile(account.id, "all");
      });

      const download = Effect.fn("SnippetHydrationEngine.download")(function* (
        account: SnippetSyncAccount,
        snippetId: string,
      ) {
        const activeAccount = yield* Ref.get(currentAccount);
        if (activeAccount?.id !== account.id || activeAccount.accessToken !== account.accessToken) {
          return yield* new SnippetHydrationError({
            cause: null,
            reason: "Reconnect storage before downloading this snippet.",
            retryable: true,
          });
        }
        const snippet = yield* currentSnippet(account.id, snippetId);
        if (snippet === null || snippet.uploadStatus !== "UPLOADED") {
          return yield* new SnippetHydrationError({
            cause: null,
            reason: "Only uploaded snippets can be downloaded.",
            retryable: false,
          });
        }
        const hydrationKey = key(account.id, snippet.id);
        if (active.has(hydrationKey)) return;
        yield* startHydration(account, snippet, true);
      });

      const state = Effect.fn("SnippetHydrationEngine.state")(function* (
        accountId: string,
        snippetId: string,
        byteSize: number,
      ) {
        const available = yield* content.available(accountId, snippetId, byteSize);
        if (available) return { status: "AVAILABLE" } as const;
        return stateWithoutValidation(key(accountId, snippetId));
      });

      return SnippetHydrationEngine.of({
        changes: Stream.fromPubSub(changes),
        download,
        pause,
        purge,
        reconcile: (accountId) => reconcile(accountId),
        resume,
        state,
        updateSettings,
      });
    }),
  );
}
