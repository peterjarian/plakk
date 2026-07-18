import { Effect, FileSystem, Layer, Option, PlatformError, Stream } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { ResolvedSnippetIngestPayload } from "../../../ipc/contracts.ts";
import { ManagedSnippetContent, ManagedSnippetContentError } from "./ManagedSnippetContent.ts";

const contentDirectory = (root: string, accountId: string, snippetId: string) =>
  join(accountContentDirectory(root, accountId), snippetId);

const accountContentDirectory = (root: string, accountId: string) =>
  join(root, Buffer.from(accountId).toString("base64url"));

export const managedSnippetContentPath = (root: string, accountId: string, snippetId: string) =>
  join(contentDirectory(root, accountId, snippetId), "content");

const managedSnippetIntegrityPath = (root: string, accountId: string, snippetId: string) =>
  join(contentDirectory(root, accountId, snippetId), "content.sha256");

const nodeErrorCode = (cause: unknown): string | null =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : null;

type ManagedContentErrorCopy = {
  readonly timedOut: string;
  readonly notFound: string;
  readonly notFoundRetryable: boolean;
  readonly permissionDenied: string;
  readonly fallback: string;
  readonly recognizesNodeTimeout: boolean;
};

const diskSpaceError =
  "There isn’t enough space on this Mac to save this file. Free some space, then try again.";

const managedContentError = (cause: PlatformError.PlatformError, copy: ManagedContentErrorCopy) => {
  let reason = copy.fallback;
  let retryable = true;

  switch (cause.reason._tag) {
    case "TimedOut":
      reason = copy.timedOut;
      break;
    case "NotFound":
      reason = copy.notFound;
      retryable = copy.notFoundRetryable;
      break;
    case "PermissionDenied":
      reason = copy.permissionDenied;
      retryable = false;
      break;
    case "Unknown": {
      const code = nodeErrorCode(cause.reason.cause);
      if (code === "ENOSPC" || code === "EDQUOT") {
        reason = diskSpaceError;
      } else if (code === "ETIMEDOUT" && copy.recognizesNodeTimeout) {
        reason = copy.timedOut;
      }
      break;
    }
  }

  return new ManagedSnippetContentError({
    cause,
    reason,
    retryable,
  });
};

const importError = (cause: PlatformError.PlatformError) =>
  managedContentError(cause, {
    timedOut:
      "This file isn’t available on this Mac yet. Check its cloud download, then try again.",
    notFound: "This file is no longer available. Choose it again.",
    notFoundRetryable: false,
    permissionDenied: "Plakk can’t read this file. Check its permissions, then choose it again.",
    fallback:
      "Plakk couldn’t save this file locally. Make sure it is available on this Mac, then try again.",
    recognizesNodeTimeout: true,
  });

const hydrationWriteError = (cause: PlatformError.PlatformError) =>
  managedContentError(cause, {
    timedOut: "Saving this snippet on this Mac timed out. Try downloading it again.",
    notFound: "Plakk could not finish the local download. Try downloading it again.",
    notFoundRetryable: true,
    permissionDenied: "Plakk can’t write this snippet to local storage. Check folder permissions.",
    fallback: "Plakk couldn’t save this downloaded snippet locally. Try downloading it again.",
    recognizesNodeTimeout: false,
  });

const validFile = (info: FileSystem.File.Info, byteSize: number) =>
  info.type === "File" && Number(info.size) === byteSize;

const fileFingerprint = (info: FileSystem.File.Info) => {
  const modifiedAt = Option.getOrNull(info.mtime)?.getTime() ?? null;
  const inode = Option.getOrNull(info.ino);
  return `${info.dev}:${inode}:${info.size}:${modifiedAt}`;
};

export const makeManagedSnippetContentLive = (root: string) =>
  Layer.effect(
    ManagedSnippetContent,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const verifiedIntegrity = new Map<string, string>();
      const textValidity = new Map<
        string,
        { readonly fingerprint: string; readonly valid: boolean }
      >();

      const discard = Effect.fn("ManagedSnippetContent.discard")(function* (
        accountId: string,
        snippetId: string,
      ) {
        const filePath = managedSnippetContentPath(root, accountId, snippetId);
        verifiedIntegrity.delete(filePath);
        textValidity.delete(filePath);
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

      const commitContent = Effect.fn("ManagedSnippetContent.commitContent")(function* <E>(
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
          if (existing !== null && integrity === undefined) return destination;

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
              if (integrity !== undefined) {
                const committed = yield* fileSystem.stat(destination);
                verifiedIntegrity.set(destination, fileFingerprint(committed));
              }
              textValidity.delete(destination);
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

      const ingestSource = Effect.fn("ManagedSnippetContent.ingestSource")(function* (
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

      const ingest = Effect.fn("ManagedSnippetContent.ingest")(function* (
        accountId: string,
        input: ResolvedSnippetIngestPayload,
      ) {
        return yield* ingestSource(
          accountId,
          "bytes" in input
            ? { id: input.id, byteSize: input.byteSize, bytes: input.bytes }
            : { id: input.id, byteSize: input.byteSize, filePath: input.filePath },
        );
      });

      const contentIsValid = Effect.fn("ManagedSnippetContent.contentIsValid")(function* (
        accountId: string,
        snippetId: string,
        byteSize: number,
      ) {
        const filePath = managedSnippetContentPath(root, accountId, snippetId);
        const info = yield* fileSystem.stat(filePath);
        const fingerprint = fileFingerprint(info);
        if (!validFile(info, byteSize)) {
          verifiedIntegrity.delete(filePath);
          textValidity.delete(filePath);
          return false;
        }

        const expected = yield* fileSystem
          .readFileString(managedSnippetIntegrityPath(root, accountId, snippetId))
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
        if (expected === null) return true;
        if (verifiedIntegrity.get(filePath) === fingerprint) return true;

        const hash = createHash("sha256");
        yield* fileSystem.stream(filePath).pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              hash.update(chunk);
            }),
          ),
        );
        const valid = hash.digest("hex") === expected.trim();
        if (valid) verifiedIntegrity.set(filePath, fingerprint);
        else verifiedIntegrity.delete(filePath);
        return valid;
      });

      const path = Effect.fn("ManagedSnippetContent.path")(function* (
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

      const get = Effect.fn("ManagedSnippetContent.get")(function* (
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

      const getPrefix = Effect.fn("ManagedSnippetContent.getPrefix")(function* (
        accountId: string,
        snippetId: string,
        maxBytes: number,
      ) {
        return yield* fileSystem
          .stream(managedSnippetContentPath(root, accountId, snippetId), {
            bytesToRead: maxBytes,
          })
          .pipe(
            Stream.runCollect,
            Effect.map((chunks) => Uint8Array.from(Buffer.concat(chunks))),
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

      const validateText = Effect.fn("ManagedSnippetContent.validateText")(function* (
        accountId: string,
        snippetId: string,
      ) {
        const filePath = managedSnippetContentPath(root, accountId, snippetId);
        const info = yield* fileSystem.stat(filePath).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
          Effect.mapError(
            (cause) =>
              new ManagedSnippetContentError({
                cause,
                reason: "Could not inspect managed snippet text.",
                retryable: true,
              }),
          ),
        );
        if (info === null) {
          textValidity.delete(filePath);
          return "NOT_FOUND" as const;
        }

        const fingerprint = fileFingerprint(info);
        const cached = textValidity.get(filePath);
        if (cached?.fingerprint === fingerprint) return cached.valid ? "VALID" : "INVALID";

        const decoder = new TextDecoder("utf-8", { fatal: true });
        let valid = true;
        yield* fileSystem.stream(filePath).pipe(
          Stream.runForEachWhile((chunk) =>
            Effect.sync(() => {
              try {
                decoder.decode(chunk, { stream: true });
                return true;
              } catch {
                valid = false;
                return false;
              }
            }),
          ),
          Effect.mapError(
            (cause) =>
              new ManagedSnippetContentError({
                cause,
                reason: "Could not validate managed snippet text.",
                retryable: true,
              }),
          ),
        );
        if (valid) {
          try {
            decoder.decode();
          } catch {
            valid = false;
          }
        }
        textValidity.set(filePath, { fingerprint, valid });
        return valid ? ("VALID" as const) : ("INVALID" as const);
      });

      const available = Effect.fn("ManagedSnippetContent.available")(function* (
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

      const putStream = Effect.fn("ManagedSnippetContent.putStream")(function* <E>(
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

      const invalidate = Effect.fn("ManagedSnippetContent.invalidate")(function* (
        accountId: string,
        snippetIds: ReadonlyArray<string>,
      ) {
        yield* Effect.forEach(snippetIds, (snippetId) => discard(accountId, snippetId), {
          discard: true,
        });
      });

      const purge = Effect.fn("ManagedSnippetContent.purge")(function* (accountId: string) {
        const directory = accountContentDirectory(root, accountId);
        for (const path of verifiedIntegrity.keys()) {
          if (path.startsWith(`${directory}/`)) verifiedIntegrity.delete(path);
        }
        for (const path of textValidity.keys()) {
          if (path.startsWith(`${directory}/`)) textValidity.delete(path);
        }
        yield* fileSystem.remove(directory, { force: true, recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new ManagedSnippetContentError({
                cause,
                reason: "Could not purge managed account content.",
                retryable: true,
              }),
          ),
        );
      });

      return ManagedSnippetContent.of({
        available,
        discard,
        get,
        getPrefix,
        ingest,
        invalidate,
        path,
        purge,
        putStream,
        validateText,
      });
    }),
  );
