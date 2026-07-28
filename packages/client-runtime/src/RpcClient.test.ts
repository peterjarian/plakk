import { expect, it } from "@effect/vitest";
import { AuthMiddleware, CurrentUser, SessionError } from "@plakk/shared/PlakkApi";
import { Effect, Layer, Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";
import * as RpcTest from "effect/unstable/rpc/RpcTest";

import { CurrentSession } from "./CurrentSession.ts";
import { AuthClientLive } from "./RpcClient.ts";

class ObserveHeadersMiddleware extends RpcMiddleware.Service<ObserveHeadersMiddleware>()(
  "@plakk/client-runtime/RpcClient.test/ObserveHeadersMiddleware",
) {}

const TestApi = RpcGroup.make(
  Rpc.make("Public", { success: Schema.Void }),
  Rpc.make("Protected", { success: Schema.Void }).middleware(AuthMiddleware),
).middleware(ObserveHeadersMiddleware);

it.effect("adds bearer authentication only to protected RPCs", () =>
  Effect.gen(function* () {
    const observed = new Map<string, string | undefined>();
    let accessToken = "token";
    let sessionError: SessionError | undefined;
    const session = Layer.succeed(
      CurrentSession,
      CurrentSession.of({
        user: {
          id: "user-1",
          firstName: "Test",
          lastName: "User",
          email: "test@example.com",
          createdAt: "2026-07-20T18:00:00.000Z",
          updatedAt: "2026-07-20T18:00:00.000Z",
        },
        accessToken: Effect.suspend(() =>
          sessionError === undefined ? Effect.succeed(accessToken) : Effect.fail(sessionError),
        ),
      }),
    );
    const handlers = TestApi.toLayer(
      Effect.succeed(
        TestApi.of({
          Public: () => Effect.void,
          Protected: () => Effect.void,
        }),
      ),
    );
    const serverAuth = Layer.succeed(
      AuthMiddleware,
      AuthMiddleware.of((effect) =>
        Effect.provideService(effect, CurrentUser, CurrentUser.of({ id: "user-1" })),
      ),
    );
    const observer = Layer.succeed(
      ObserveHeadersMiddleware,
      ObserveHeadersMiddleware.of((effect, { headers, rpc }) =>
        Effect.sync(() => {
          observed.set(rpc._tag, headers.authorization);
        }).pipe(Effect.andThen(effect)),
      ),
    );
    const client = yield* RpcTest.makeClient(TestApi).pipe(
      Effect.provide(
        Layer.mergeAll(handlers, serverAuth, observer, AuthClientLive.pipe(Layer.provide(session))),
      ),
    );

    yield* client.Public(undefined);
    yield* client.Protected(undefined);
    accessToken = "refreshed-token";
    yield* client.Protected(undefined);

    expect(observed.get("Public")).toBeUndefined();
    expect(observed.get("Protected")).toBe("Bearer refreshed-token");

    sessionError = new SessionError({ message: "The session expired." });
    expect(yield* client.Protected(undefined).pipe(Effect.flip)).toEqual(sessionError);
  }),
);
