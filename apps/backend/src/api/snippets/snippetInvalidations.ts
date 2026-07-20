import type { DrizzleService } from "@plakk/db";
import { PgClient, sql } from "@plakk/db";
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
  notifications: Stream.Stream<string, E>,
  ownerWorkosUserId: string,
): Stream.Stream<typeof SNIPPETS_CHANGED, E> =>
  Stream.merge(
    Stream.succeed(SNIPPETS_CHANGED),
    notifications.pipe(
      Stream.filter((notifiedOwner) => notifiedOwner === ownerWorkosUserId),
      Stream.map(() => SNIPPETS_CHANGED),
    ),
    { haltStrategy: "both" },
  );

const eventChunk = (value: string) => new TextEncoder().encode(value);

export const snippetInvalidationBytes = <E>(
  notifications: Stream.Stream<string, E>,
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
  notifications: Stream.Stream<string, E>,
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
    const pg = yield* PgClient.PgClient;
    yield* router.add("GET", "/api/snippets/invalidations", (request) =>
      Effect.gen(function* () {
        const currentUser = yield* authenticateRequest(request.headers);
        const notifications = pg
          .listen(SNIPPET_INVALIDATION_CHANNEL)
          .pipe(
            Stream.tapError((error) =>
              Effect.logError("Snippet invalidation listener failed", { error }),
            ),
          );
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
