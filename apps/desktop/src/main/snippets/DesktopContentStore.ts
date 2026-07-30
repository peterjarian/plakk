import { ContentStore, LocalStorageError } from "@plakk/client-runtime";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Context, Effect, FileSystem, Layer, Option, PlatformError, Stream } from "effect";

/** Opens the native filesystem content adapter for one user. */
export class DesktopContentStore extends Context.Service<
  DesktopContentStore,
  {
    readonly forUser: (userId: string) => ContentStore["Service"];
  }
>()("plakk/main/snippets/DesktopContentStore") {}

const accountDirectory = (root: string, userId: string) =>
  join(root, Buffer.from(userId).toString("base64url"));

const snippetDirectory = (root: string, userId: string, snippetId: string) =>
  join(accountDirectory(root, userId), snippetId);

export const desktopContentPath = (root: string, userId: string, snippetId: string) =>
  join(snippetDirectory(root, userId, snippetId), "content");

const integrityPath = (root: string, userId: string, snippetId: string) =>
  join(snippetDirectory(root, userId, snippetId), "content.sha256");

const storageError = (cause: PlatformError.PlatformError, message: string) =>
  new LocalStorageError({ cause, message });

const validFile = (info: FileSystem.File.Info, byteSize: number) =>
  info.type === "File" && Number(info.size) === byteSize;

const fingerprint = (info: FileSystem.File.Info) =>
  `${info.dev}:${Option.getOrNull(info.ino)}:${info.size}:${
    Option.getOrNull(info.mtime)?.getTime() ?? null
  }`;

/** Builds the native filesystem adapter shared by every active desktop user. */
export const makeDesktopContentStoreLayer = (root: string) =>
  Layer.effect(
    DesktopContentStore,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const verified = new Map<string, string>();

      const clearCache = (userId: string, snippetId: string) => {
        const path = desktopContentPath(root, userId, snippetId);
        verified.delete(path);
      };

      const hashFile = Effect.fn("DesktopContentStore.hashFile")(function* (path: string) {
        const hash = createHash("sha256");
        yield* fileSystem.stream(path).pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              hash.update(chunk);
            }),
          ),
        );
        return hash.digest("hex");
      });

      const remove = Effect.fn("DesktopContentStore.remove")(function* (
        userId: string,
        snippetIds: ReadonlyArray<string>,
      ) {
        yield* Effect.forEach(
          snippetIds,
          (snippetId) => {
            clearCache(userId, snippetId);
            return fileSystem
              .remove(snippetDirectory(root, userId, snippetId), {
                force: true,
                recursive: true,
              })
              .pipe(
                Effect.mapError((cause) =>
                  storageError(cause, "Plakk could not remove locally stored snippet content."),
                ),
              );
          },
          { discard: true },
        );
      });

      const isValid = Effect.fn("DesktopContentStore.isValid")(function* (
        userId: string,
        snippetId: string,
        byteSize: number,
      ) {
        return yield* Effect.gen(function* () {
          const path = desktopContentPath(root, userId, snippetId);
          const info = yield* fileSystem.stat(path);
          if (!validFile(info, byteSize)) {
            clearCache(userId, snippetId);
            return false;
          }

          const expected = yield* fileSystem
            .readFileString(integrityPath(root, userId, snippetId))
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
          if (expected === null) {
            clearCache(userId, snippetId);
            return false;
          }

          const currentFingerprint = fingerprint(info);
          if (verified.get(path) === currentFingerprint) return true;
          const valid = (yield* hashFile(path)) === expected.trim();
          if (valid) verified.set(path, currentFingerprint);
          else clearCache(userId, snippetId);
          return valid;
        }).pipe(
          Effect.mapError((cause) =>
            storageError(cause, "Plakk could not inspect locally stored snippet content."),
          ),
        );
      });

      const entries = Effect.fn("DesktopContentStore.entries")(function* (userId: string) {
        const snippetIds = yield* fileSystem.readDirectory(accountDirectory(root, userId)).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
          Effect.mapError((cause) =>
            storageError(cause, "Plakk could not inspect locally stored snippet content."),
          ),
        );
        const inspected = yield* Effect.forEach(snippetIds, (snippetId) =>
          fileSystem.stat(desktopContentPath(root, userId, snippetId)).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
            Effect.mapError((cause) =>
              storageError(cause, "Plakk could not inspect locally stored snippet content."),
            ),
            Effect.flatMap((info) => {
              if (info === null) return Effect.succeed(null);
              if (info.type !== "File") return Effect.succeed(null);
              const byteSize = Number(info.size);
              return isValid(userId, snippetId, byteSize).pipe(
                Effect.flatMap((valid) =>
                  valid
                    ? Effect.succeed({ snippetId, byteSize })
                    : remove(userId, [snippetId]).pipe(Effect.as(null)),
                ),
              );
            }),
          ),
        );
        return inspected.filter((entry) => entry !== null);
      });

      const write = Effect.fn("DesktopContentStore.write")(function* <E>(
        userId: string,
        snippetId: string,
        byteSize: number,
        source: Stream.Stream<Uint8Array, E>,
      ) {
        const directory = snippetDirectory(root, userId, snippetId);
        const destination = desktopContentPath(root, userId, snippetId);
        const work = Effect.gen(function* () {
          const existing = yield* fileSystem.stat(destination).pipe(
            Effect.map((info) => (validFile(info, byteSize) ? info : null)),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
          );
          if (existing !== null) {
            const expected = yield* fileSystem
              .readFileString(integrityPath(root, userId, snippetId))
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
            if (expected !== null && (yield* hashFile(destination)) === expected.trim()) {
              verified.set(destination, fingerprint(existing));
              return;
            }
          }

          clearCache(userId, snippetId);
          yield* fileSystem.remove(directory, { force: true, recursive: true });
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const temporary = yield* fileSystem.makeTempFileScoped({
                directory,
                prefix: ".content-",
              });
              yield* Stream.run(source, fileSystem.sink(temporary));
              const imported = yield* fileSystem.stat(temporary);
              if (!validFile(imported, byteSize)) {
                return yield* new LocalStorageError({
                  message: "Stored content does not match its expected size.",
                });
              }
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const file = yield* fileSystem.open(temporary);
                  yield* file.sync;
                }),
              );
              const integrity = integrityPath(root, userId, snippetId);
              yield* fileSystem.writeFileString(integrity, yield* hashFile(temporary));
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const file = yield* fileSystem.open(integrity);
                  yield* file.sync;
                }),
              );
              yield* fileSystem.rename(temporary, destination);
              verified.set(destination, fingerprint(yield* fileSystem.stat(destination)));
            }),
          );
        });

        yield* work.pipe(
          Effect.onError(() =>
            fileSystem
              .remove(directory, { force: true, recursive: true })
              .pipe(Effect.catch(() => Effect.void)),
          ),
          Effect.catchIf(
            (cause): cause is PlatformError.PlatformError =>
              cause instanceof PlatformError.PlatformError,
            (cause) =>
              Effect.fail(
                storageError(cause, "Plakk could not save locally stored snippet content."),
              ),
          ),
        );
      });

      const read = (userId: string, snippetId: string) =>
        fileSystem
          .stream(desktopContentPath(root, userId, snippetId))
          .pipe(
            Stream.mapError((cause) =>
              storageError(cause, "Plakk could not read locally stored snippet content."),
            ),
          );

      const readRange = Effect.fn("DesktopContentStore.readRange")(function* (
        userId: string,
        snippetId: string,
        offset: number,
        byteSize: number,
      ) {
        const chunks = yield* fileSystem
          .stream(desktopContentPath(root, userId, snippetId), {
            offset,
            bytesToRead: byteSize,
          })
          .pipe(
            Stream.runCollect,
            Effect.mapError((cause) =>
              storageError(cause, "Plakk could not read locally stored snippet content."),
            ),
          );
        return Uint8Array.from(Buffer.concat(chunks));
      });

      const forUser = (userId: string): ContentStore["Service"] =>
        ContentStore.of({
          entries: entries(userId),
          write: (snippetId, byteSize, source) => write(userId, snippetId, byteSize, source),
          read: (snippetId) => read(userId, snippetId),
          readRange: (snippetId, offset, byteSize) =>
            readRange(userId, snippetId, offset, byteSize),
          remove: (snippetIds) => remove(userId, snippetIds),
        });

      return DesktopContentStore.of({ forUser });
    }),
  );
