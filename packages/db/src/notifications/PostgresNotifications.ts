import { Cause, Config, Context, Effect, Layer, Queue, Redacted, Schema, Stream } from "effect";
import { Client, escapeIdentifier, type Notification } from "pg";

export type PostgresNotificationEvent =
  | { readonly _tag: "Connected" }
  | { readonly _tag: "Notification"; readonly payload: string };

export class PostgresNotificationError extends Schema.TaggedErrorClass<PostgresNotificationError>()(
  "PostgresNotificationError",
  {
    cause: Schema.Defect(),
  },
) {}

export interface PostgresNotificationClient {
  connect(): Promise<unknown>;
  query(statement: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "notification", listener: (notification: Notification) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end", listener: () => void): this;
  off(event: "notification", listener: (notification: Notification) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "end", listener: () => void): this;
}

export type PostgresNotificationClientFactory = () => PostgresNotificationClient;

export const makePostgresNotificationStream = (
  makeClient: PostgresNotificationClientFactory,
  channel: string,
): Stream.Stream<PostgresNotificationEvent, PostgresNotificationError> =>
  Stream.callback<PostgresNotificationEvent, PostgresNotificationError>((queue) =>
    Effect.gen(function* () {
      const client = makeClient();
      let released = false;
      const fail = (cause: unknown) => {
        if (released) return;
        Queue.failCauseUnsafe(queue, Cause.fail(new PostgresNotificationError({ cause })));
      };
      const onNotification = (notification: Notification) => {
        if (notification.channel !== channel || notification.payload === undefined) return;
        Queue.offerUnsafe(queue, {
          _tag: "Notification",
          payload: notification.payload,
        });
      };
      const onError = (error: Error) => fail(error);
      const onEnd = () => fail(new Error("PostgreSQL notification connection ended."));

      client.on("notification", onNotification);
      client.on("error", onError);
      client.on("end", onEnd);

      const acquire = Effect.tryPromise({
        try: async () => {
          await client.connect();
          await client.query(`LISTEN ${escapeIdentifier(channel)}`);
          Queue.offerUnsafe(queue, { _tag: "Connected" });
          return client;
        },
        catch: (cause) => new PostgresNotificationError({ cause }),
      }).pipe(
        Effect.onError(() =>
          Effect.tryPromise(() => client.end()).pipe(Effect.catchCause(() => Effect.void)),
        ),
      );

      yield* Effect.acquireRelease(acquire, () => {
        released = true;
        client.off("notification", onNotification);
        client.off("error", onError);
        client.off("end", onEnd);
        return Effect.tryPromise(() => client.end()).pipe(Effect.catchCause(() => Effect.void));
      });
    }),
  );

export class PostgresNotifications extends Context.Service<
  PostgresNotifications,
  {
    readonly listen: (
      channel: string,
    ) => Stream.Stream<PostgresNotificationEvent, PostgresNotificationError>;
  }
>()("@plakk/db/notifications/PostgresNotifications") {}

export const PostgresNotificationsLive = Layer.effect(
  PostgresNotifications,
  Effect.gen(function* () {
    const databaseUrl = yield* Config.redacted("DATABASE_URL");
    const makeClient = (): PostgresNotificationClient =>
      new Client({
        connectionString: Redacted.value(databaseUrl),
        application_name: "plakk-postgres-notifications",
      });
    return PostgresNotifications.of({
      listen: (channel) => makePostgresNotificationStream(makeClient, channel),
    });
  }),
);
