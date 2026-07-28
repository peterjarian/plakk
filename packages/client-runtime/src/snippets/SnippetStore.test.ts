import { SqliteClient } from "@effect/sql-sqlite-node";
import { expect, it } from "@effect/vitest";
import type { User } from "@plakk/shared";
import { Effect, Fiber, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CurrentSession } from "../CurrentSession.ts";
import { clientMigrationsLayer } from "../sqlite/Migrations.ts";
import { SnippetStore } from "./SnippetStore.ts";

const user: User = {
  id: "user-1",
  firstName: "Test",
  lastName: "User",
  email: "test@example.com",
  createdAt: "2026-07-20T18:00:00.000Z",
  updatedAt: "2026-07-20T18:00:00.000Z",
};
const snippetId = "0d1e2f3a-4567-4890-8abc-def012345678";

it.effect("subscribes with the current snapshot and publishes committed changes", () => {
  const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
  const databaseLayer = clientMigrationsLayer.pipe(Layer.provideMerge(sqliteLayer));
  const layer = SnippetStore.Live.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provide(
      Layer.succeed(
        CurrentSession,
        CurrentSession.of({ user, accessToken: Effect.succeed("token") }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const snippets = yield* SnippetStore;
    const sql = yield* SqlClient.SqlClient;
    yield* snippets.refresh;

    const fiber = yield* snippets
      .subscribe()
      .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
    yield* Effect.yieldNow;

    yield* sql`
      INSERT INTO client_snippets (
        user_id,
        id,
        file_name,
        byte_size,
        storage_provider,
        storage_object_id,
        status,
        error_message,
        created_at,
        updated_at
      )
      VALUES (
        ${user.id},
        ${snippetId},
        'note.txt',
        4,
        'GOOGLE_DRIVE',
        NULL,
        'UPLOADING',
        NULL,
        '2026-07-20T20:00:00.000Z',
        '2026-07-20T20:00:00.000Z'
      )
    `;
    yield* snippets.refresh;

    const snapshots = yield* Fiber.join(fiber);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual([]);
    expect(snapshots[1]?.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: snippetId, status: "UPLOADING" },
    ]);
  }).pipe(Effect.provide(layer));
});
