import { Context } from "effect";
import type { Effect, PlatformError } from "effect";

export type NativeFileSource = {
  readonly filePath: string;
  readonly temporary: boolean;
};

export interface NativeFileSourcesShape {
  readonly register: (
    filePath: string,
    options?: { readonly temporary?: boolean },
  ) => Effect.Effect<string, PlatformError.PlatformError>;
  readonly take: (sourceId: string) => NativeFileSource | undefined;
  readonly discardAll: () => ReadonlyArray<string>;
}

export class NativeFileSources extends Context.Service<NativeFileSources, NativeFileSourcesShape>()(
  "plakk/main/snippets/sources/NativeFileSources",
) {}
