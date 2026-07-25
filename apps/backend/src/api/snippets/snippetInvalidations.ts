import type { DrizzleService } from "@plakk/db";
import { PostgresNotifications, type PostgresNotificationEvent, sql } from "@plakk/db";
import { SNIPPETS_CHANGED } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { authenticateRequest } from "../auth/authenticateRequest.ts";

export const SNIPPET_INVALIDATION_CHANNEL = "plakk_snippet_invalidations";

type NotificationDatabase = Pick<DrizzleService["db"], "execute">;

export const notifySnippetChanges = Effect.fn("notifySnippetChanges")(function* (
  db: NotificationDatabase,
  ownerWorkosUserId: string,
) {
  yield* db.execute(sql`select pg_notify(${SNIPPET_INVALIDATION_CHANNEL}, ${ownerWorkosUserId})`);
});

export const snippetInvalidationStream = <E>(
  notifications: Stream.Stream<PostgresNotificationEvent, E>,
  ownerWorkosUserId: string,
): Stream.Stream<typeof SNIPPETS_CHANGED, E> =>
  Stream.merge(
    Stream.succeed(SNIPPETS_CHANGED),
    notifications.pipe(
      Stream.filter((event) => event._tag === "Connected" || event.payload === ownerWorkosUserId),
      Stream.map(() => SNIPPETS_CHANGED),
    ),
    { haltStrategy: "both" },
  );

export const reconnectSnippetNotifications = <E>(
  listen: () => Stream.Stream<PostgresNotificationEvent, E>,
) =>
  Stream.suspend(() => {
    let attempts = 0;
    return Stream.suspend(() => {
      attempts += 1;
      return listen().pipe(Stream.filter((event) => event._tag !== "Connected" || attempts > 1));
    }).pipe(
      Stream.tapError((error) =>
        Effect.logWarning("PostgreSQL notification listener disconnected", { error }),
      ),
      Stream.retry(Schedule.spaced("1 second")),
    );
  });

const eventChunk = (value: string) => new TextEncoder().encode(value);

export const snippetInvalidationBytes = <E>(
  notifications: Stream.Stream<PostgresNotificationEvent, E>,
  ownerWorkosUserId: string,
) => {
  const invalidations = snippetInvalidationStream(notifications, ownerWorkosUserId).pipe(
    Stream.map((event) => eventChunk(`data: ${event}\n\n`)),
  );
  const keepAlive = Stream.fromSchedule(Schedule.spaced("15 seconds")).pipe(
    Stream.map(() => eventChunk(": keep-alive\n\n")),
  );
  return Stream.merge(invalidations, keepAlive);
};

export const makeSnippetInvalidationsResponse = <E>(
  notifications: Stream.Stream<PostgresNotificationEvent, E>,
  ownerWorkosUserId: string,
) =>
  HttpServerResponse.stream(snippetInvalidationBytes(notifications, ownerWorkosUserId), {
    contentType: "text/event-stream",
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });

export const SnippetInvalidationsRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const postgresNotifications = yield* PostgresNotifications;
    const notifications = yield* reconnectSnippetNotifications(() =>
      postgresNotifications.listen(SNIPPET_INVALIDATION_CHANNEL),
    ).pipe(Stream.share({ capacity: "unbounded" }));
    yield* router.add("GET", "/api/snippets/invalidations", (request) =>
      Effect.gen(function* () {
        const currentUser = yield* authenticateRequest(request.headers);
        yield* Effect.logInfo("Snippet SSE stream connected", {
          ownerWorkosUserId: currentUser.id,
        });
        return makeSnippetInvalidationsResponse(notifications, currentUser.id).pipe(
          HttpServerResponse.setHeader("vary", "authorization"),
        );
      }).pipe(
        Effect.catchTag("RpcError", (error: RpcError) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { code: error.code, message: error.message },
              { status: error.code === "UNAUTHENTICATED" ? 401 : 500 },
            ),
          ),
        ),
      ),
    );
  }),
);
