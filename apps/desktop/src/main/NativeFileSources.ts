import { randomUUID } from "node:crypto";
import { Context, Layer } from "effect";

type NativeFileSource = {
  readonly filePath: string;
  readonly temporary: boolean;
};

export class NativeFileSources extends Context.Service<
  NativeFileSources,
  {
    register(filePath: string, options?: { readonly temporary?: boolean }): string;
    take(sourceId: string): NativeFileSource | undefined;
    discardAll(): ReadonlyArray<string>;
  }
>()("plakk/main/NativeFileSources") {
  static readonly Live = Layer.sync(NativeFileSources, () => {
    const sources = new Map<string, NativeFileSource>();
    return NativeFileSources.of({
      register: (filePath, options = {}) => {
        const sourceId = randomUUID();
        sources.set(sourceId, { filePath, temporary: options.temporary === true });
        return sourceId;
      },
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
  });
}
