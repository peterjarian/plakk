import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import ElectronStore from "electron-store";
import { join } from "node:path";
import { Effect, FileSystem, Layer } from "effect";

import { makeDesktopSqliteLayer } from "../../persistence/Sqlite.ts";
import {
  SnippetReplica,
  type LocalUploadRecord,
  type PublishedSnippetRecord,
  type SnippetReplicaState,
} from "./SnippetReplica.ts";
import { decodeStoredSnippetReplica, makeSnippetReplicaLive } from "./SnippetReplicaLive.ts";

const accountId = "user_1";
const published: PublishedSnippetRecord = {
  kind: "PUBLISHED",
  snippet: {
    id: "0d1e2f3a-4567-4890-8abc-def012345678",
    fileName: "published.txt",
    byteSize: 12,
    storageProvider: "GOOGLE_DRIVE",
    storageObjectId: "drive-id",
    createdAt: "2026-07-10T20:00:00.000Z",
    updatedAt: "2026-07-10T20:00:01.000Z",
  },
};
const local: LocalUploadRecord = {
  kind: "LOCAL",
  id: "1d1e2f3a-4567-4890-8abc-def012345679",
  fileName: "uploading.txt",
  byteSize: 24,
  storageProvider: "GOOGLE_DRIVE",
  status: "UPLOADING",
  errorMessage: null,
  createdAt: "2026-07-10T20:00:02.000Z",
  updatedAt: "2026-07-10T20:00:03.000Z",
};

const withReplica = <A, E>(
  databasePath: string,
  legacyStoreCwd: string,
  effect: Effect.Effect<A, E, SnippetReplica>,
) =>
  effect.pipe(
    Effect.provide(
      makeSnippetReplicaLive({ legacyStoreCwd }).pipe(
        Layer.provide(makeDesktopSqliteLayer(databasePath)),
      ),
    ),
  );

describe("stored Device Snippet collection", () => {
  it.effect("rejects the superseded authoritative upload-status shape", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeStoredSnippetReplica(
          JSON.stringify({
            items: [
              {
                id: "0d1e2f3a-4567-4890-8abc-def012345678",
                fileName: "legacy.txt",
                byteSize: 12,
                storageProvider: "GOOGLE_DRIVE",
                storageObjectId: "drive-id",
                uploadStatus: "UPLOADED",
                createdAt: "2026-07-10T20:00:00.000Z",
                updatedAt: "2026-07-10T20:00:01.000Z",
              },
            ],
          }),
        ),
      );

      expect(result._tag).toBe("Failure");
    }),
  );
});

it.layer(NodeFileSystem.layer)("SQLite snippet replica", (it) => {
  it.effect("persists ordered records and empty replicas across database restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-sqlite-replica-" });
      const databasePath = join(cwd, "plakk.sqlite");

      yield* withReplica(
        databasePath,
        cwd,
        Effect.gen(function* () {
          const replica = yield* SnippetReplica;
          expect(yield* replica.get(accountId)).toBeNull();
          yield* replica.commit(accountId, { items: [published] });
          yield* replica.update(accountId, (state) => ({
            items: [...state.items, local],
          }));
        }),
      );

      const restarted = yield* withReplica(
        databasePath,
        cwd,
        SnippetReplica.use((replica) => replica.get(accountId)),
      );
      expect(restarted).toEqual({ items: [published, local] });

      yield* withReplica(
        databasePath,
        cwd,
        SnippetReplica.use((replica) =>
          replica
            .remove(accountId, published.snippet.id)
            .pipe(Effect.andThen(replica.commit(accountId, { items: [] }))),
        ),
      );

      const empty = yield* withReplica(
        databasePath,
        cwd,
        SnippetReplica.use((replica) => replica.get(accountId)),
      );
      expect(empty).toEqual({ items: [] });
    }),
  );

  it.effect("imports electron-store replicas once without overwriting later SQLite state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-sqlite-import-" });
      const databasePath = join(cwd, "plakk.sqlite");
      const legacy = new ElectronStore<Record<string, string>>({
        accessPropertiesByDotNotation: false,
        cwd,
        name: "snippet-replicas",
      });
      const legacyState: SnippetReplicaState = { items: [published, local] };
      legacy.set(accountId, JSON.stringify(legacyState));
      legacy.set("invalid_account", "not-json");

      const imported = yield* withReplica(
        databasePath,
        cwd,
        SnippetReplica.use((replica) => replica.get(accountId)),
      );
      expect(imported).toEqual(legacyState);
      expect(legacy.store).toEqual({});

      yield* withReplica(
        databasePath,
        cwd,
        SnippetReplica.use((replica) => replica.purge(accountId)),
      );
      legacy.set(accountId, JSON.stringify(legacyState));

      const afterRestart = yield* withReplica(
        databasePath,
        cwd,
        SnippetReplica.use((replica) => replica.get(accountId)),
      );
      expect(afterRestart).toBeNull();
      expect(legacy.store).toEqual({});
    }),
  );
});
