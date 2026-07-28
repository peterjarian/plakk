import { Context, Crypto, Effect, Layer, type PlatformError } from "effect";

export type NativeFileSource = {
  readonly filePath: string;
  readonly temporary: boolean;
};

/**
 * Retains native file paths behind opaque renderer-safe identifiers until a
 * single ingestion command consumes them.
 */
export class NativeFileSources extends Context.Service<
  NativeFileSources,
  {
    /** Registers a native path and returns its one-time opaque identifier. */
    readonly register: (
      filePath: string,
      options?: { readonly temporary?: boolean },
    ) => Effect.Effect<string, PlatformError.PlatformError>;
    /** Consumes one registered source so it cannot be reused. */
    readonly take: (sourceId: string) => NativeFileSource | undefined;
    /** Clears every source and returns temporary paths requiring deletion. */
    readonly discardAll: () => ReadonlyArray<string>;
  }
>()("plakk/main/snippets/NativeFileSources") {
  static readonly layer = Layer.effect(
    NativeFileSources,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const sources = new Map<string, NativeFileSource>();

      return NativeFileSources.of({
        register: (filePath, options = {}) =>
          crypto.randomUUIDv4.pipe(
            Effect.tap((sourceId) =>
              Effect.sync(() => {
                sources.set(sourceId, {
                  filePath,
                  temporary: options.temporary === true,
                });
              }),
            ),
          ),
        take: (sourceId) => {
          const source = sources.get(sourceId);
          if (source !== undefined) sources.delete(sourceId);
          return source;
        },
        discardAll: () => {
          const temporaryPaths = [...sources.values()]
            .filter((source) => source.temporary)
            .map((source) => source.filePath);
          sources.clear();
          return temporaryPaths;
        },
      });
    }),
  );
}
