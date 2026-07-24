import { Effect, FiberMap, Layer, PubSub, Ref, Semaphore, Stream } from "effect";

import type { LocalContentAvailability } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { ManagedSnippetContent } from "../content/ManagedSnippetContent.ts";
import { SnippetReplica } from "../replica/SnippetReplica.ts";
import type { SnippetSyncAccount } from "../replica/SnippetRemoteTransport.ts";

import {
  SnippetHydrationEngine,
  SnippetHydrationError,
  type SnippetHydrationShape,
} from "./SnippetHydration.ts";
import { SnippetHydrationTransport } from "./SnippetHydrationTransport.ts";

export const AUTOMATIC_HYDRATION_MAX_BYTES = 1024 * 1024 * 1024;
export const AUTOMATIC_HYDRATION_LIMIT = 20;

export const shouldHydrateAutomatically = (snippet: { readonly byteSize: number }): boolean =>
  snippet.byteSize < AUTOMATIC_HYDRATION_MAX_BYTES;

export const automaticHydrationSnippets = (
  snippets: ReadonlyArray<ApiSnippet>,
): ReadonlyArray<ApiSnippet> =>
  snippets
    .filter(shouldHydrateAutomatically)
    .toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    )
    .slice(0, AUTOMATIC_HYDRATION_LIMIT);

const makeSnippetHydration = Effect.gen(function* () {
  const content = yield* ManagedSnippetContent;
  const replica = yield* SnippetReplica;
  const transport = yield* SnippetHydrationTransport;
  const changes = yield* PubSub.unbounded<string>();
  const currentAccount = yield* Ref.make<SnippetSyncAccount | null>(null);
  const concurrency = yield* Semaphore.make(2);
  const fibers = yield* FiberMap.make<string>();
  const active = new Set<string>();
  const automaticAttempts = new Set<string>();

  const key = (accountId: string, snippetId: string) => `${accountId}/${snippetId}`;
  const publish = (accountId: string) => PubSub.publish(changes, accountId);
  const stateWithoutValidation = (hydrationKey: string): LocalContentAvailability =>
    active.has(hydrationKey) ? { status: "DOWNLOADING" } : { status: "NOT_AVAILABLE" };

  const currentSnippet = Effect.fn("SnippetHydrationEngine.currentSnippet")(function* (
    accountId: string,
    snippetId: string,
  ) {
    const state = yield* replica.get(accountId);
    const record = state?.items.find(
      (item) => item.kind === "PUBLISHED" && item.snippet.id === snippetId,
    );
    return record?.kind === "PUBLISHED" ? record.snippet : null;
  });

  const freeUpSpace = Effect.fn("SnippetHydrationEngine.freeUpSpace")(function* (
    accountId: string,
  ) {
    const state = yield* replica.get(accountId);
    const published = (state?.items ?? []).flatMap((record) =>
      record.kind === "PUBLISHED" ? [record.snippet] : [],
    );
    const retained = new Set(automaticHydrationSnippets(published).map(({ id }) => id));
    const reclamation = yield* content.removeExcept(accountId, retained);
    const storageUsageBytes = yield* content.storageUsageBytes(accountId);
    return { ...reclamation, storageUsageBytes };
  });

  const hydrate = Effect.fn("SnippetHydrationEngine.hydrate")(function* (
    account: SnippetSyncAccount,
    snippet: ApiSnippet,
  ) {
    yield* content.putStream(
      account.id,
      snippet.id,
      snippet.byteSize,
      transport.stream(account, snippet),
    );

    const latest = yield* currentSnippet(account.id, snippet.id);
    if (latest === null) {
      yield* content.invalidate(account.id, [snippet.id]);
      return;
    }
  });

  const startHydration = Effect.fn("SnippetHydrationEngine.startHydration")(function* (
    account: SnippetSyncAccount,
    snippet: ApiSnippet,
    invalidateFirst = false,
    automatic = false,
  ) {
    const hydrationKey = key(account.id, snippet.id);
    if (active.has(hydrationKey)) return;
    active.add(hydrationKey);
    if (automatic) automaticAttempts.add(hydrationKey);

    const work = Effect.gen(function* () {
      yield* Effect.yieldNow;
      yield* publish(account.id);
      if (invalidateFirst) yield* content.invalidate(account.id, [snippet.id]);
      yield* concurrency.withPermit(hydrate(account, snippet)).pipe(
        Effect.catchCause((cause) =>
          content.invalidate(account.id, [snippet.id]).pipe(
            Effect.catchCause(() => Effect.void),
            Effect.andThen(
              Effect.logWarning("Snippet download did not complete", {
                snippetId: snippet.id,
                cause,
              }),
            ),
          ),
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

  const reconcile = Effect.fn("SnippetHydrationEngine.reconcile")(function* (accountId: string) {
    const account = yield* Ref.get(currentAccount);
    if (account?.id !== accountId) return new Map<string, LocalContentAvailability>();
    const state = yield* replica.get(accountId);
    const uploaded = (state?.items ?? []).flatMap((record) =>
      record.kind === "PUBLISHED" ? [record.snippet] : [],
    );
    const uploadedKeys = new Set(uploaded.map((snippet) => key(accountId, snippet.id)));
    const automatic = automaticHydrationSnippets(uploaded);
    const automaticKeys = new Set(automatic.map((snippet) => key(accountId, snippet.id)));
    const accountPrefix = `${accountId}/`;

    for (const hydrationKey of automaticAttempts) {
      if (hydrationKey.startsWith(accountPrefix) && !automaticKeys.has(hydrationKey)) {
        automaticAttempts.delete(hydrationKey);
      }
    }

    yield* Effect.forEach(
      [...active].filter(
        (hydrationKey) => hydrationKey.startsWith(accountPrefix) && !uploadedKeys.has(hydrationKey),
      ),
      (hydrationKey) =>
        FiberMap.remove(fibers, hydrationKey).pipe(
          Effect.andThen(
            Effect.sync(() => {
              active.delete(hydrationKey);
              automaticAttempts.delete(hydrationKey);
            }),
          ),
        ),
      { discard: true },
    );

    const availability = yield* Effect.forEach(
      uploaded,
      (snippet) => {
        const inspect = Effect.gen(function* () {
          const hydrationKey = key(accountId, snippet.id);
          if (active.has(hydrationKey)) {
            return [snippet.id, stateWithoutValidation(hydrationKey)] as const;
          }
          const available = yield* content.available(accountId, snippet.id, snippet.byteSize);
          if (available) return [snippet.id, { status: "AVAILABLE" } as const] as const;
          yield* content.invalidate(accountId, [snippet.id]);
          if (automaticKeys.has(hydrationKey) && !automaticAttempts.has(hydrationKey)) {
            yield* startHydration(account, snippet, false, true);
          }
          return [snippet.id, stateWithoutValidation(hydrationKey)] as const;
        });
        return inspect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not inspect managed snippet content", {
              snippetId: snippet.id,
              error,
            }).pipe(Effect.as([snippet.id, { status: "NOT_AVAILABLE" } as const] as const)),
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
    for (const hydrationKey of automaticAttempts) {
      if (hydrationKey.startsWith(prefix)) automaticAttempts.delete(hydrationKey);
    }
    yield* publish(accountId);
  });

  const resume = Effect.fn("SnippetHydrationEngine.resume")(function* (
    account: SnippetSyncAccount,
  ) {
    const previous = yield* Ref.get(currentAccount);
    if (
      previous !== null &&
      (previous.id !== account.id || previous.accessToken !== account.accessToken)
    ) {
      yield* pause;
    }
    yield* Ref.set(currentAccount, account);
    yield* reconcile(account.id);
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
    if (snippet === null) {
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

  return {
    changes: Stream.fromPubSub(changes),
    download,
    freeUpSpace,
    pause,
    purge,
    reconcile: (accountId) => reconcile(accountId),
    resume,
    state,
  } satisfies SnippetHydrationShape;
});

export const SnippetHydrationLive = Layer.effect(SnippetHydrationEngine, makeSnippetHydration);
