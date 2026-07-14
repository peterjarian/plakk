import { PgClient, PgClientLive } from "@plakk/db";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { authenticateRequest } from "./auth/authenticateRequest.ts";
import { ServerMemoMap } from "./ServerRuntime.ts";

const CHANGE_CHANNEL = "snippet_changes";
const WAKE_MESSAGE = "event: changes-available\ndata:\n\n";
export const snippetChangeRecoveryWakeStream = Stream.fromEffect(
  Effect.sleep("15 seconds").pipe(Effect.as(WAKE_MESSAGE)),
).pipe(Stream.repeat(Schedule.forever));

export const snippetChangeWakeStream = <E>(
  notifications: Stream.Stream<string, E>,
  ownerWorkosUserId: string,
): Stream.Stream<string, E> =>
  Stream.concat(
    Stream.succeed(WAKE_MESSAGE),
    notifications.pipe(
      Stream.filter((notifiedOwner) => notifiedOwner === ownerWorkosUserId),
      Stream.map(() => WAKE_MESSAGE),
    ),
  );

const SnippetChangeEventsRoutes = HttpRouter.use(
  Effect.fn("SnippetChangeEventsRoutes")(function* (router) {
    yield* router.add(
      "GET",
      "/api/snippet-changes/events",
      Effect.fn("handleSnippetChangeEvents")(function* (request) {
        yield* Effect.annotateCurrentSpan({ transport: "sse" });
        const currentUser = yield* authenticateRequest(request.headers).pipe(Effect.option);
        if (Option.isNone(currentUser)) {
          yield* Effect.annotateCurrentSpan({ authenticated: false });
          yield* Effect.logWarning("Rejected unauthenticated snippet change SSE connection");
          return yield* HttpServerResponse.json(
            { code: "UNAUTHENTICATED", message: "Sign in to continue." },
            { status: 401 },
          ).pipe(Effect.orDie);
        }

        yield* Effect.annotateCurrentSpan({ authenticated: true });
        const pg = yield* PgClient.PgClient;
        const notifications = pg.listen(CHANGE_CHANNEL).pipe(
          Stream.tapError((error) =>
            Effect.logError("Snippet change SSE listener failed", { error }),
          ),
          Stream.orDie,
        );
        const events = Stream.concat(
          Stream.fromEffect(Effect.logInfo("Snippet change SSE connected")).pipe(Stream.drain),
          Stream.merge(
            snippetChangeWakeStream(notifications, currentUser.value.id),
            snippetChangeRecoveryWakeStream,
          ),
        ).pipe(
          Stream.ensuring(Effect.logInfo("Snippet change SSE disconnected")),
          Stream.withSpan("snippetChangeEvents", { attributes: { transport: "sse" } }),
        );

        return HttpServerResponse.stream(events.pipe(Stream.encodeText), {
          contentType: "text/event-stream",
          headers: {
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          },
        });
      }),
    );
  }),
);

export const { handler: handleSnippetChangeEventsRequest } = HttpRouter.toWebHandler(
  SnippetChangeEventsRoutes.pipe(HttpRouter.provideRequest(PgClientLive)),
  { disableLogger: true, memoMap: ServerMemoMap },
);
