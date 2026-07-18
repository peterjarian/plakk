import { randomUUID } from "node:crypto";
import { Layer } from "effect";

import {
  NativeFileSources,
  type NativeFileSource,
  type NativeFileSourcesShape,
} from "../Services/NativeFileSources.ts";

const makeNativeFileSources = (): NativeFileSourcesShape => {
  const sources = new Map<string, NativeFileSource>();
  return {
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
  };
};

export const NativeFileSourcesLive = Layer.sync(NativeFileSources, makeNativeFileSources);
