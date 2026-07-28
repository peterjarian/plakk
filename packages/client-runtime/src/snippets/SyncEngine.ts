import { SNIPPETS_CHANGED, OfflineError, SessionError } from "@plakk/shared/PlakkApi";
import type { RpcError } from "@plakk/shared/RpcError";
import { Cause, Context, Effect, Layer, Option, Stream } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CurrentSession } from "../CurrentSession.ts";
import {
  ActionNotAllowedError,
  InvalidResponseError,
  LocalStorageError,
  ServerUnavailableError,
  SnippetConflictError,
  SnippetNotFoundError,
} from "../models/ClientError.ts";
import { RpcClient } from "../RpcClient.ts";
import { removeSnippet } from "../sqlite/queries/snippets.ts";
import { applySnippetSnapshot } from "../sqlite/queries/sync.ts";
import { ContentStore } from "./ContentMirror.ts";
import { SnippetStore } from "./SnippetStore.ts";

export type SyncFailure =
  | ActionNotAllowedError
  | InvalidResponseError
  | LocalStorageError
  | OfflineError
  | ServerUnavailableError
  | SessionError
  | SnippetConflictError
  | SnippetNotFoundError;

export class SyncEngine extends Context.Service<
  SyncEngine,
  {
    /** Pulls and atomically applies the latest backend snippet snapshot. */
    readonly pull: Effect.Effect<void, SyncFailure>;
    /** Keeps pulling after startup, invalidation signals, and reconnects. */
    readonly run: Effect.Effect<never>;
    /** Deletes a published snippet remotely and then removes its local record. */
    readonly delete: (snippetId: string) => Effect.Effect<void, SyncFailure>;
  }
>()("@plakk/client-runtime/snippets/SyncEngine") {
  static readonly Live = Layer.effect(
    SyncEngine,
    Effect.gen(function* () {
      const session = yield* CurrentSession;
      const rpc = yield* RpcClient;
      const sql = yield* SqlClient.SqlClient;
      const snippets = yield* SnippetStore;
      const content = Option.getOrUndefined(yield* Effect.serviceOption(ContentStore));

      /** Converts a backend-declared failure into a safe runtime error. */
      const failRpc = (error: RpcError): Effect.Effect<never, SyncFailure> => {
        switch (error.code) {
          case "UNAUTHENTICATED":
            return Effect.fail(
              new SessionError({
                message: "Your session expired. Sign in again to continue.",
              }),
            );
          case "FORBIDDEN":
            return Effect.fail(
              new ActionNotAllowedError({
                message: "You do not have permission to do that.",
              }),
            );
          case "NOT_FOUND":
            return Effect.fail(
              new SnippetNotFoundError({
                message: "This snippet no longer exists.",
              }),
            );
          case "CONFLICT":
            return Effect.fail(
              new SnippetConflictError({
                message: "The snippet changed elsewhere. Please try again.",
              }),
            );
          case "INTERNAL_SERVER_ERROR":
            return Effect.fail(
              new ServerUnavailableError({
                message: "Plakk could not complete the request. Please try again.",
              }),
            );
        }
      };

      /** Converts an RPC transport failure without exposing protocol details. */
      const failRpcClient = (
        error: RpcClientError,
      ): Effect.Effect<never, InvalidResponseError | OfflineError> =>
        error.reason._tag === "RpcClientDefect"
          ? Effect.fail(
              new InvalidResponseError({
                message: "Plakk received an unexpected response.",
              }),
            )
          : Effect.fail(
              new OfflineError({
                message: "Plakk could not connect. Check your connection and try again.",
              }),
            );

      /** Pulls and atomically applies the latest backend snippet snapshot. */
      const pull = Effect.gen(function* () {
        const snapshot = yield* rpc.GetSnippetSnapshot(undefined);
        yield* applySnippetSnapshot(session.user.id, snapshot);
        yield* snippets.refresh;
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({
          RpcClientError: failRpcClient,
          RpcError: failRpc,
          SchemaError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not update its local data.",
              }),
            ),
          SqlError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not update its local data.",
              }),
            ),
        }),
        Effect.withSpan("SyncEngine.pull"),
      );

      /** Keeps pulling after startup, invalidation signals, and reconnects. */
      const run = Effect.gen(function* () {
        while (true) {
          yield* pull.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Initial snippet sync failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          );

          yield* rpc.WatchSnippetInvalidations(undefined).pipe(
            Stream.filter((event) => event === SNIPPETS_CHANGED),
            Stream.runForEach(() => pull),
            Effect.catchCause((cause) =>
              Effect.logWarning("Snippet sync disconnected", {
                cause: Cause.pretty(cause),
              }),
            ),
          );

          yield* Effect.sleep("5 seconds");
        }
      }).pipe(Effect.withSpan("SyncEngine.run"));

      /** Deletes a published snippet remotely and then removes its local record. */
      const deleteSnippet = Effect.fn("SyncEngine.delete")(
        function* (snippetId: string) {
          yield* rpc.DeleteSnippet({ id: snippetId });
          yield* removeSnippet(session.user.id, snippetId);
          yield* snippets.refresh;
          if (content !== undefined) {
            yield* content.remove([snippetId]).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not remove deleted snippet content", {
                  snippetId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          }
        },
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({
          RpcClientError: failRpcClient,
          RpcError: failRpc,
          SqlError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not remove the local snippet.",
              }),
            ),
        }),
      );

      return SyncEngine.of({ pull, run, delete: deleteSnippet });
    }),
  );
}
