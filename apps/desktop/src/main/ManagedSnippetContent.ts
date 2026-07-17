import { ManagedSnippetContent, ManagedSnippetContentError } from "@plakk/shared/SnippetReplica";
import { Context, Effect, FileSystem, Layer, PlatformError, Stream } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { SnippetIngestPayload } from "../ipc/contracts.ts";

const contentDirectory = (root: string, accountId: string, snippetId: string) =>
  join(root, Buffer.from(accountId).toString("base64url"), snippetId);

export const managedSnippetContentPath = (root: string, accountId: string, snippetId: string) =>
  join(contentDirectory(root, accountId, snippetId), "content");

const managedSnippetIntegrityPath = (root: string, accountId: string, snippetId: string) =>
  join(contentDirectory(root, accountId, snippetId), "content.sha256");

const nodeErrorCode = (cause: unknown): string | null =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : null;

const importError = (cause: PlatformError.PlatformError) => {
  switch (cause.reason._tag) {
    case "TimedOut":
      return new ManagedSnippetContentError({
        cause,
        reason:
          "This file isn’t available on this Mac yet. Check its cloud download, then try again.",
        retryable: true,
      });
    case "NotFound":
      return new ManagedSnippetContentError({
        cause,
        reason: "This file is no longer available. Choose it again.",
        retryable: false,
      });
    case "PermissionDenied":
      return new ManagedSnippetContentError({
        cause,
        reason: "Plakk can’t read this file. Check its permissions, then choose it again.",
        retryable: false,
      });
    case "Unknown": {
      const code = nodeErrorCode(cause.reason.cause);
      if (code === "ETIMEDOUT") {
        return new ManagedSnippetContentError({
          cause,
          reason:
            "This file isn’t available on this Mac yet. Check its cloud download, then try again.",
          retryable: true,
        });
      }
      if (code === "ENOSPC" || code === "EDQUOT") {
        return new ManagedSnippetContentError({
          cause,
          reason:
            "There isn’t enough space on this Mac to save this file. Free some space, then try again.",
          retryable: true,
        });
      }
      break;
    }
  }

  return new ManagedSnippetContentError({
    cause,
    reason:
      "Plakk couldn’t save this file locally. Make sure it is available on this Mac, then try again.",
    retryable: true,
  });
};

const hydrationWriteError = (cause: PlatformError.PlatformError) => {
  switch (cause.reason._tag) {
    case "TimedOut":
      return new ManagedSnippetContentError({
        cause,
        reason: "Saving this snippet on this Mac timed out. Try downloading it again.",
        retryable: true,
      });
    case "NotFound":
      return new ManagedSnippetContentError({
        cause,
        reason: "Plakk could not finish the local download. Try downloading it again.",
        retryable: true,
      });
    case "PermissionDenied":
      return new ManagedSnippetContentError({
        cause,
        reason: "Plakk can’t write this snippet to local storage. Check folder permissions.",
        retryable: false,
      });
    case "Unknown": {
      const code = nodeErrorCode(cause.reason.cause);
      if (code === "ENOSPC" || code === "EDQUOT") {
        return new ManagedSnippetContentError({
          cause,
          reason:
            "There isn’t enough space on this Mac to save this file. Free some space, then try again.",
          retryable: true,
        });
      }
      break;
    }
  }
  return new ManagedSnippetContentError({
    cause,
    reason: "Plakk couldn’t save this downloaded snippet locally. Try downloading it again.",
    retryable: true,
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
    putStream<E>(
      accountId: string,
      snippetId: string,
      byteSize: number,
      source: Stream.Stream<Uint8Array, E>,
    ): Effect.Effect<void, E | ManagedSnippetContentError>;
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
                    retryable: true,
                  }),
              ),
            );
        });

        const commitContent = Effect.fn("DesktopManagedSnippetContent.commitContent")(function* <E>(
          accountId: string,
          snippetId: string,
          byteSize: number,
          write: (temporary: string) => Effect.Effect<void, E>,
          mismatchReason: string,
          mapPlatformError: (cause: PlatformError.PlatformError) => ManagedSnippetContentError,
          integrity?: () => string,
        ) {
          const directory = contentDirectory(root, accountId, snippetId);
          const destination = managedSnippetContentPath(root, accountId, snippetId);
          const importContent = Effect.gen(function* () {
            const existing = yield* fileSystem.stat(destination).pipe(
              Effect.map((info) => (validFile(info, byteSize) ? info : null)),
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
                yield* write(temporary);

                const imported = yield* fileSystem.stat(temporary);
                if (!validFile(imported, byteSize)) {
                  return yield* new ManagedSnippetContentError({
                    cause: null,
                    reason: mismatchReason,
                    retryable: false,
                  });
                }
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    const file = yield* fileSystem.open(temporary);
                    yield* file.sync;
                  }),
                );
                if (integrity !== undefined) {
                  const integrityFile = managedSnippetIntegrityPath(root, accountId, snippetId);
                  yield* fileSystem.writeFileString(integrityFile, integrity());
                  yield* Effect.scoped(
                    Effect.gen(function* () {
                      const file = yield* fileSystem.open(integrityFile);
                      yield* file.sync;
                    }),
                  );
                }
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
            Effect.catchIf(
              (cause): cause is PlatformError.PlatformError =>
                cause instanceof PlatformError.PlatformError,
              (cause) => Effect.fail(mapPlatformError(cause)),
            ),
          );
        });

        const ingestSource = Effect.fn("DesktopManagedSnippetContent.ingestSource")(function* (
          accountId: string,
          input:
            | { readonly id: string; readonly byteSize: number; readonly filePath: string }
            | { readonly id: string; readonly byteSize: number; readonly bytes: Uint8Array },
        ) {
          return yield* commitContent(
            accountId,
            input.id,
            input.byteSize,
            (temporary) =>
              "bytes" in input
                ? fileSystem.writeFile(temporary, input.bytes)
                : fileSystem.copyFile(input.filePath, temporary),
            "The selected file changed while Plakk was saving it. Choose it again.",
            importError,
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

        const contentIsValid = Effect.fn("DesktopManagedSnippetContent.contentIsValid")(function* (
          accountId: string,
          snippetId: string,
          byteSize: number,
        ) {
          const filePath = managedSnippetContentPath(root, accountId, snippetId);
          const info = yield* fileSystem.stat(filePath);
          if (!validFile(info, byteSize)) return false;

          const expected = yield* fileSystem
            .readFileString(managedSnippetIntegrityPath(root, accountId, snippetId))
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
          if (expected === null) return true;

          const hash = createHash("sha256");
          yield* fileSystem.stream(filePath).pipe(
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                hash.update(chunk);
              }),
            ),
          );
          return hash.digest("hex") === expected.trim();
        });

        const path = Effect.fn("DesktopManagedSnippetContent.path")(function* (
          accountId: string,
          snippetId: string,
          byteSize: number,
        ) {
          const valid = yield* contentIsValid(accountId, snippetId, byteSize).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedSnippetContentError({
                  cause,
                  reason: "The local copy of this snippet is unavailable.",
                  retryable: true,
                }),
            ),
          );
          if (!valid) {
            return yield* new ManagedSnippetContentError({
              cause: null,
              reason: "The local copy of this snippet is incomplete or corrupt.",
              retryable: false,
            });
          }
          return managedSnippetContentPath(root, accountId, snippetId);
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
                    retryable: true,
                  }),
              ),
            );
        });

        const available = Effect.fn("DesktopManagedSnippetContent.available")(function* (
          accountId: string,
          snippetId: string,
          byteSize: number,
        ) {
          return yield* contentIsValid(accountId, snippetId, byteSize).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
            Effect.mapError(
              (cause) =>
                new ManagedSnippetContentError({
                  cause,
                  reason: "Could not inspect managed snippet content.",
                  retryable: true,
                }),
            ),
          );
        });

        const putStream = Effect.fn("DesktopManagedSnippetContent.putStream")(function* <E>(
          accountId: string,
          snippetId: string,
          byteSize: number,
          source: Stream.Stream<Uint8Array, E>,
        ) {
          const hash = createHash("sha256");
          yield* commitContent(
            accountId,
            snippetId,
            byteSize,
            (temporary) =>
              Stream.run(
                source.pipe(
                  Stream.tap((chunk) =>
                    Effect.sync(() => {
                      hash.update(chunk);
                    }),
                  ),
                ),
                fileSystem.sink(temporary),
              ),
            "Hydrated content does not match its metadata.",
            hydrationWriteError,
            () => hash.digest("hex"),
          );
        });

        return DesktopManagedSnippetContent.of({
          available,
          discard,
          get,
          ingest,
          path,
          putStream,
        });
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
        putStream: (accountId, snippetId, byteSize, source) =>
          content.putStream(accountId, snippetId, byteSize, source),
        available: (accountId, snippetId, byteSize) =>
          content.available(accountId, snippetId, byteSize),
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
