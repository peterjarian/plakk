import { SnippetHydrationEngine } from "@plakk/shared/SnippetHydration";
import { SnippetReplica } from "@plakk/shared/SnippetReplica";
import { Context, Effect, Layer, Schema } from "effect";

import { DesktopProjection } from "./DesktopProjection.ts";
import { DesktopManagedSnippetContent } from "./ManagedSnippetContent.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";
import { SnippetUploadOutbox } from "./SnippetUploadOutbox.ts";

export class DesktopAccountPurgeError extends Schema.TaggedErrorClass<DesktopAccountPurgeError>()(
  "DesktopAccountPurgeError",
  { failures: Schema.Array(Schema.Struct({ owner: Schema.String, cause: Schema.Defect() })) },
) {}

type DesktopAccountDataOwners = {
  readonly replica: SnippetReplica["Service"];
  readonly uploads: SnippetUploadEngine["Service"];
  readonly outbox: SnippetUploadOutbox["Service"];
  readonly hydration: SnippetHydrationEngine["Service"];
  readonly content: DesktopManagedSnippetContent["Service"];
  readonly projection: DesktopProjection["Service"];
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
      attempt("legacy upload outbox", owners.outbox.purge(accountId)),
      attempt("managed content", owners.content.purge(accountId)),
    ],
    { concurrency: "unbounded", discard: true },
  );
  yield* attempt("desktop projection", owners.projection.update({ kind: "signed-out" }));
  if (failures.length > 0) return yield* new DesktopAccountPurgeError({ failures });
});

export class DesktopAccountData extends Context.Service<
  DesktopAccountData,
  { purge(accountId: string): Effect.Effect<void, DesktopAccountPurgeError> }
>()("plakk/main/DesktopAccountData") {
  static readonly Live = Layer.effect(
    DesktopAccountData,
    Effect.gen(function* () {
      const owners: DesktopAccountDataOwners = {
        replica: yield* SnippetReplica,
        uploads: yield* SnippetUploadEngine,
        outbox: yield* SnippetUploadOutbox,
        hydration: yield* SnippetHydrationEngine,
        content: yield* DesktopManagedSnippetContent,
        projection: yield* DesktopProjection,
      };
      return DesktopAccountData.of({ purge: (accountId) => purgeWith(accountId, owners) });
    }),
  );
}
