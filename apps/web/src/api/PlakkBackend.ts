import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";

const mockStorageProvider = "GOOGLE_DRIVE" as const;
const mockAccountStatus: AccountStatus = {
  canSync: true,
  storageProvider: mockStorageProvider,
  blockedReasons: [],
};

const titleFromText = (text: string) =>
  text.trim().split(/\s+/).slice(0, 8).join(" ") || "Untitled note";

const mockSnippet = Effect.fn("@plakk/web/api/PlakkBackend.mockSnippet")(function* (input: {
  readonly kind: "TEXT" | "FILE" | "IMAGE";
  readonly title: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly contentType: string | null;
}) {
  const id = yield* Random.nextInt;
  const now = DateTime.toDateUtc(yield* DateTime.now).toISOString();

  return {
    id: `mock-snippet-${id}`,
    storageProvider: mockStorageProvider,
    createdAt: now,
    updatedAt: now,
    ...input,
  } satisfies ApiSnippet;
});

export class PlakkBackend extends Context.Service<
  PlakkBackend,
  {
    readonly getAccountStatus: Effect.Effect<AccountStatus>;
    readonly listSnippets: (input: {
      readonly limit: number;
    }) => Effect.Effect<{ readonly items: readonly ApiSnippet[] }>;
    readonly createTextSnippet: (text: string) => Effect.Effect<ApiSnippet>;
    readonly createStoredSnippet: (input: {
      readonly kind: "FILE" | "IMAGE";
      readonly title: string;
      readonly fileName: string;
      readonly byteSize: number;
      readonly contentType: string | null;
    }) => Effect.Effect<ApiSnippet>;
    readonly deleteSnippet: (id: string) => Effect.Effect<void>;
  }
>()("@plakk/web/api/PlakkBackend") {
  static readonly Live = Layer.succeed(
    PlakkBackend,
    PlakkBackend.of({
      getAccountStatus: Effect.gen(function* () {
        yield* Effect.logInfo("Returning mock account status", {
          storageProvider: mockStorageProvider,
        });
        return mockAccountStatus;
      }),
      listSnippets: Effect.fn("@plakk/web/api/PlakkBackend.listSnippets")(function* (input) {
        yield* Effect.logInfo("Listing mock snippets", { limit: input.limit });
        return { items: [] };
      }),
      createTextSnippet: Effect.fn("@plakk/web/api/PlakkBackend.createTextSnippet")(
        function* (text) {
          const title = titleFromText(text);
          yield* Effect.logInfo("Creating mock text snippet", { byteSize: text.length });
          return yield* mockSnippet({
            kind: "TEXT",
            title,
            fileName: `${title}.txt`,
            byteSize: new TextEncoder().encode(text).byteLength,
            contentType: "text/plain",
          });
        },
      ),
      createStoredSnippet: Effect.fn("@plakk/web/api/PlakkBackend.createStoredSnippet")(
        function* (input) {
          yield* Effect.logInfo("Creating mock stored snippet", {
            kind: input.kind,
            byteSize: input.byteSize,
          });
          return yield* mockSnippet(input);
        },
      ),
      deleteSnippet: Effect.fn("@plakk/web/api/PlakkBackend.deleteSnippet")(function* (id) {
        yield* Effect.logInfo("Deleting mock snippet", { id });
      }),
    }),
  );
}
