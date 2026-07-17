import { ManagedSnippetContent, ManagedSnippetContentError } from "@plakk/shared/SnippetReplica";
import { Context, Effect, FileSystem, Layer, PlatformError } from "effect";
import { join } from "node:path";

import type { SnippetIngestPayload } from "../ipc/contracts.ts";

const contentDirectory = (root: string, accountId: string, snippetId: string) =>
  join(root, Buffer.from(accountId).toString("base64url"), snippetId);

export const managedSnippetContentPath = (root: string, accountId: string, snippetId: string) =>
  join(contentDirectory(root, accountId, snippetId), "content");

const nodeErrorCode = (cause: unknown): string | null =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : null;

const importError = (cause: PlatformError.PlatformError) => {
  switch (cause.reason._tag) {
    case "TimedOut":
      return new ManagedSnippetContentError({
        cause,
        reason:
          "This file isn’t available on this Mac yet. Check its cloud download, then try again.",
      });
    case "NotFound":
      return new ManagedSnippetContentError({
        cause,
        reason: "This file is no longer available. Choose it again.",
      });
    case "PermissionDenied":
      return new ManagedSnippetContentError({
        cause,
        reason: "Plakk can’t read this file. Check its permissions, then choose it again.",
      });
    case "Unknown": {
      const code = nodeErrorCode(cause.reason.cause);
      if (code === "ETIMEDOUT") {
        return new ManagedSnippetContentError({
          cause,
          reason:
            "This file isn’t available on this Mac yet. Check its cloud download, then try again.",
        });
      }
      if (code === "ENOSPC") {
        return new ManagedSnippetContentError({
          cause,
          reason:
            "There isn’t enough space on this Mac to save this file. Free some space, then try again.",
        });
      }
      break;
    }
  }

  return new ManagedSnippetContentError({
    cause,
    reason:
      "Plakk couldn’t save this file locally. Make sure it is available on this Mac, then try again.",
  });
};

const validFile = (info: FileSystem.File.Info, byteSize: number) =>
  info.type === "File" && Number(info.size) === byteSize;

export class DesktopManagedSnippetContent extends Context.Service<
  DesktopManagedSnippetContent,
  {
    ingest(
      accountId: string,
      input: SnippetIngestPayload,
    ): Effect.Effect<string, ManagedSnippetContentError>;
    path(
      accountId: string,
      snippetId: string,
      byteSize: number,
    ): Effect.Effect<string, ManagedSnippetContentError>;
    available(
      accountId: string,
      snippetId: string,
      byteSize: number,
    ): Effect.Effect<boolean, ManagedSnippetContentError>;
    get(
      accountId: string,
      snippetId: string,
    ): Effect.Effect<Uint8Array | null, ManagedSnippetContentError>;
    put(
      accountId: string,
      snippetId: string,
      bytes: Uint8Array,
    ): Effect.Effect<void, ManagedSnippetContentError>;
    discard(accountId: string, snippetId: string): Effect.Effect<void, ManagedSnippetContentError>;
  }
>()("plakk/main/DesktopManagedSnippetContent") {
  static layer(root: string) {
    return Layer.effect(
      DesktopManagedSnippetContent,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;

        const discard = Effect.fn("DesktopManagedSnippetContent.discard")(function* (
          accountId: string,
          snippetId: string,
        ) {
          yield* fileSystem
            .remove(contentDirectory(root, accountId, snippetId), {
              force: true,
              recursive: true,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedSnippetContentError({
                    cause,
                    reason: "Could not remove managed snippet content.",
                  }),
              ),
            );
        });

        const ingestSource = Effect.fn("DesktopManagedSnippetContent.ingestSource")(function* (
          accountId: string,
          input:
            | { readonly id: string; readonly byteSize: number; readonly filePath: string }
            | { readonly id: string; readonly byteSize: number; readonly bytes: Uint8Array },
        ) {
          const directory = contentDirectory(root, accountId, input.id);
          const destination = managedSnippetContentPath(root, accountId, input.id);
          const importContent = Effect.gen(function* () {
            const existing = yield* fileSystem.stat(destination).pipe(
              Effect.map((info) => (validFile(info, input.byteSize) ? info : null)),
              Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
            );
            if (existing !== null) return destination;

            yield* fileSystem.remove(directory, { force: true, recursive: true });
            yield* fileSystem.makeDirectory(directory, { recursive: true });
            yield* Effect.scoped(
              Effect.gen(function* () {
                const temporary = yield* fileSystem.makeTempFileScoped({
                  directory,
                  prefix: ".import-",
                });
                if ("bytes" in input) yield* fileSystem.writeFile(temporary, input.bytes);
                else yield* fileSystem.copyFile(input.filePath, temporary);

                const imported = yield* fileSystem.stat(temporary);
                if (!validFile(imported, input.byteSize)) {
                  return yield* new ManagedSnippetContentError({
                    cause: null,
                    reason: "The selected file changed while Plakk was saving it. Choose it again.",
                  });
                }
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    const file = yield* fileSystem.open(temporary);
                    yield* file.sync;
                  }),
                );
                yield* fileSystem.rename(temporary, destination);
              }),
            );
            return destination;
          });

          return yield* importContent.pipe(
            Effect.onError(() =>
              fileSystem
                .remove(directory, { force: true, recursive: true })
                .pipe(Effect.catch(() => Effect.void)),
            ),
            Effect.catchTag("PlatformError", (cause) => Effect.fail(importError(cause))),
          );
        });

        const ingest = Effect.fn("DesktopManagedSnippetContent.ingest")(function* (
          accountId: string,
          input: SnippetIngestPayload,
        ) {
          return yield* ingestSource(
            accountId,
            "bytes" in input
              ? { id: input.id, byteSize: input.byteSize, bytes: input.bytes }
              : { id: input.id, byteSize: input.byteSize, filePath: input.filePath },
          );
        });

        const path = Effect.fn("DesktopManagedSnippetContent.path")(function* (
          accountId: string,
          snippetId: string,
          byteSize: number,
        ) {
          const filePath = managedSnippetContentPath(root, accountId, snippetId);
          const info = yield* fileSystem.stat(filePath).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedSnippetContentError({
                  cause,
                  reason: "The local copy of this snippet is unavailable.",
                }),
            ),
          );
          if (!validFile(info, byteSize)) {
            return yield* new ManagedSnippetContentError({
              cause: null,
              reason: "The local copy of this snippet is incomplete.",
            });
          }
          return filePath;
        });

        const get = Effect.fn("DesktopManagedSnippetContent.get")(function* (
          accountId: string,
          snippetId: string,
        ) {
          return yield* fileSystem
            .readFile(managedSnippetContentPath(root, accountId, snippetId))
            .pipe(
              Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
              Effect.mapError(
                (cause) =>
                  new ManagedSnippetContentError({
                    cause,
                    reason: "Could not read managed snippet content.",
                  }),
              ),
            );
        });

        const available = Effect.fn("DesktopManagedSnippetContent.available")(function* (
          accountId: string,
          snippetId: string,
          byteSize: number,
        ) {
          return yield* fileSystem.stat(managedSnippetContentPath(root, accountId, snippetId)).pipe(
            Effect.map((info) => validFile(info, byteSize)),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
            Effect.mapError(
              (cause) =>
                new ManagedSnippetContentError({
                  cause,
                  reason: "Could not inspect managed snippet content.",
                }),
            ),
          );
        });

        const put = Effect.fn("DesktopManagedSnippetContent.put")(function* (
          accountId: string,
          snippetId: string,
          bytes: Uint8Array,
        ) {
          yield* ingestSource(accountId, {
            id: snippetId,
            byteSize: bytes.byteLength,
            bytes,
          });
        });

        return DesktopManagedSnippetContent.of({ available, discard, get, ingest, path, put });
      }),
    );
  }
}

export const managedSnippetContentFromDesktopLayer = Layer.effect(
  ManagedSnippetContent,
  DesktopManagedSnippetContent.use((content) =>
    Effect.succeed(
      ManagedSnippetContent.of({
        get: (accountId, snippetId) => content.get(accountId, snippetId),
        put: (accountId, snippetId, bytes) => content.put(accountId, snippetId, bytes),
        invalidate: Effect.fn("DesktopManagedSnippetContent.invalidate")(
          function* (accountId, snippetIds) {
            yield* Effect.forEach(
              snippetIds,
              (snippetId) => content.discard(accountId, snippetId),
              {
                discard: true,
              },
            );
          },
        ),
      }),
    ),
  ),
);
