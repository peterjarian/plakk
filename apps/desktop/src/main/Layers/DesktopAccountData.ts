import { SnippetReplica } from "@plakk/shared/SnippetReplica";
import { Effect, Layer } from "effect";

import { DesktopManagedSnippetContent } from "../ManagedSnippetContent.ts";
import {
  DesktopAccountData,
  DesktopAccountPurgeError,
  type DesktopAccountDataShape,
} from "../Services/DesktopAccountData.ts";
import { LocalState } from "../Services/LocalState.ts";
import { SnippetHydrationEngine } from "../Services/SnippetHydration.ts";
import { SnippetUploadEngine } from "../SnippetUploadEngine.ts";

type DesktopAccountDataOwners = {
  readonly replica: SnippetReplica["Service"];
  readonly uploads: SnippetUploadEngine["Service"];
  readonly hydration: SnippetHydrationEngine["Service"];
  readonly content: DesktopManagedSnippetContent["Service"];
  readonly localState: LocalState["Service"];
};

const purgeWith = Effect.fn("DesktopAccountData.purgeWith")(function* (
  accountId: string,
  owners: DesktopAccountDataOwners,
) {
  const failures: Array<{ readonly owner: string; readonly cause: unknown }> = [];
  const attempt = <A, E>(owner: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          failures.push({ owner, cause });
        }),
      ),
    );

  yield* Effect.all(
    [
      attempt("upload recovery", owners.uploads.purge(accountId)),
      attempt("hydration", owners.hydration.purge(accountId)),
      attempt("readable mirror", owners.replica.purge(accountId)),
      attempt("managed content", owners.content.purge(accountId)),
    ],
    { concurrency: "unbounded", discard: true },
  );
  if (failures.length > 0) return yield* new DesktopAccountPurgeError({ failures });
  yield* owners.localState
    .update({ kind: "signed-out" })
    .pipe(
      Effect.mapError(
        (cause) => new DesktopAccountPurgeError({ failures: [{ owner: "local state", cause }] }),
      ),
    );
});

const makeDesktopAccountData = Effect.gen(function* () {
  const owners: DesktopAccountDataOwners = {
    replica: yield* SnippetReplica,
    uploads: yield* SnippetUploadEngine,
    hydration: yield* SnippetHydrationEngine,
    content: yield* DesktopManagedSnippetContent,
    localState: yield* LocalState,
  };
  return {
    purge: (accountId) => purgeWith(accountId, owners),
  } satisfies DesktopAccountDataShape;
});

export const DesktopAccountDataLive = Layer.effect(DesktopAccountData, makeDesktopAccountData);
