import { PgClient } from "@plakk/db";
import { CurrentUser } from "@plakk/shared/PlakkApi";
import { SNIPPET_CHANGES_AVAILABLE } from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

export const snippetChangeRecoveryWakeStream = Stream.fromEffect(
  Effect.sleep("15 seconds").pipe(Effect.as(SNIPPET_CHANGES_AVAILABLE)),
).pipe(Stream.repeat(Schedule.forever));

export const snippetChangeWakeStream = <E>(
  notifications: Stream.Stream<string, E>,
  ownerWorkosUserId: string,
): Stream.Stream<typeof SNIPPET_CHANGES_AVAILABLE, E> =>
  Stream.concat(
    Stream.succeed(SNIPPET_CHANGES_AVAILABLE),
    notifications.pipe(
      Stream.filter((notifiedOwner) => notifiedOwner === ownerWorkosUserId),
      Stream.map(() => SNIPPET_CHANGES_AVAILABLE),
    ),
  );

export const snippetChangeRpcStream = Stream.unwrap(
  Effect.gen(function* () {
    const currentUser = yield* CurrentUser;
    const pg = yield* PgClient.PgClient;
    const notifications = pg.listen("snippet_changes").pipe(
      Stream.tapError((error) => Effect.logError("Snippet change RPC listener failed", { error })),
      Stream.orDie,
    );
    return Stream.concat(
      Stream.fromEffect(Effect.logInfo("Snippet change RPC stream connected")).pipe(Stream.drain),
      Stream.merge(
        snippetChangeWakeStream(notifications, currentUser.id),
        snippetChangeRecoveryWakeStream,
      ),
    ).pipe(
      Stream.ensuring(Effect.logInfo("Snippet change RPC stream disconnected")),
      Stream.withSpan("snippetChangeWakes", { attributes: { transport: "rpc" } }),
    );
  }),
);
