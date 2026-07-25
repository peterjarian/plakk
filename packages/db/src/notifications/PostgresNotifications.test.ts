import { EventEmitter } from "node:events";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  PostgresNotificationError,
  type PostgresNotificationClient,
  makePostgresNotificationStream,
} from "./PostgresNotifications.ts";

class TestNotificationClient extends EventEmitter implements PostgresNotificationClient {
  readonly connected = Promise.withResolvers<void>();
  readonly listening = Promise.withResolvers<void>();
  readonly statements: Array<string> = [];
  ended = false;

  connect() {
    this.connected.resolve();
    return Promise.resolve();
  }

  query(statement: string) {
    this.statements.push(statement);
    this.listening.resolve();
    return Promise.resolve();
  }

  end() {
    this.ended = true;
    return Promise.resolve();
  }
}

describe("PostgresNotifications", () => {
  it("emits readiness and matching PostgreSQL notifications", async () => {
    const client = new TestNotificationClient();
    const result = Effect.runPromise(
      makePostgresNotificationStream(() => client, "snippet_changes").pipe(
        Stream.take(2),
        Stream.runCollect,
      ),
    );

    await client.listening.promise;
    client.emit("notification", {
      channel: "other_channel",
      payload: "ignored",
      processId: 1,
    });
    client.emit("notification", {
      channel: "snippet_changes",
      payload: "account-1",
      processId: 1,
    });

    await expect(result).resolves.toEqual(
      expect.arrayContaining([
        { _tag: "Connected" },
        { _tag: "Notification", payload: "account-1" },
      ]),
    );
    expect(client.statements).toEqual(['LISTEN "snippet_changes"']);
    expect(client.ended).toBe(true);
  });

  it("fails the stream when PostgreSQL drops the listener connection", async () => {
    const client = new TestNotificationClient();
    const failure = Effect.runPromise(
      makePostgresNotificationStream(() => client, "snippet_changes").pipe(
        Stream.runDrain,
        Effect.flip,
      ),
    );

    await client.connected.promise;
    client.emit("error", new Error("connection dropped"));

    await expect(failure).resolves.toBeInstanceOf(PostgresNotificationError);
    expect(client.ended).toBe(true);
  });
});
