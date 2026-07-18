import { Crypto, Effect, Layer } from "effect";

import {
  NativeFileSources,
  type NativeFileSource,
  type NativeFileSourcesShape,
} from "../Services/NativeFileSources.ts";

const makeNativeFileSources = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sources = new Map<string, NativeFileSource>();
  return {
    register: (filePath, options = {}) =>
      crypto.randomUUIDv4.pipe(
        Effect.tap((sourceId) =>
          Effect.sync(() => {
            sources.set(sourceId, { filePath, temporary: options.temporary === true });
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
  } satisfies NativeFileSourcesShape;
});

export const NativeFileSourcesLive = Layer.effect(NativeFileSources, makeNativeFileSources);
