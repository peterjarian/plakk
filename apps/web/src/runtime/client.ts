import { SqliteClient } from "@effect/sql-sqlite-wasm";
import {
  Client,
  clientLayer,
  CurrentSession,
  OfflineError,
  SessionError,
} from "@plakk/client-runtime";
import type { User } from "@plakk/shared";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

const configuredRpcUrl = import.meta.env.VITE_PLAKK_RPC_URL;
if (configuredRpcUrl === undefined && !import.meta.env.DEV) {
  throw new Error("VITE_PLAKK_RPC_URL must be set for production builds.");
}
const rpcUrl = configuredRpcUrl ?? "http://localhost:3100/api/rpc";

export type ClientResource = {
  readonly client: Client["Service"];
  readonly runtime: ManagedRuntime.ManagedRuntime<Client, unknown>;
};

export type RunClient = <A, E>(
  operation: (client: Client["Service"]) => Effect.Effect<A, E>,
) => Promise<A>;

export const databaseNameFor = (userId: string) => `plakk-${userId}.sqlite`;
export const databaseLockNameFor = (userId: string) => `plakk:sqlite:${databaseNameFor(userId)}`;
export const runtimeChannelNameFor = (userId: string) => `plakk:runtime:${userId}`;

export const collectBytes = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunks) => {
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }),
  );

export const makeSqliteLayer = (databaseName: string) =>
  SqliteClient.layer({
    worker: Effect.acquireRelease(
      Effect.sync(
        () =>
          new Worker(new URL("./sqlite-worker.ts", import.meta.url), {
            name: databaseName,
            type: "module",
          }),
      ),
      (worker) => Effect.sync(() => worker.terminate()),
    ),
  });

export function makeClientRuntime(
  user: User,
  getAccessToken: () => Promise<string | undefined>,
): ClientResource["runtime"] {
  const sessionLayer = Layer.succeed(
    CurrentSession,
    CurrentSession.of({
      user,
      accessToken: Effect.tryPromise({
        try: async () => {
          const token = await getAccessToken();
          if (token === undefined) {
            throw new SessionError({
              message: "Your session expired. Sign in again to continue.",
            });
          }
          return token;
        },
        catch: (cause) =>
          Schema.is(SessionError)(cause)
            ? cause
            : new OfflineError({
                message: "Plakk could not refresh your session.",
              }),
      }),
    }),
  );
  const sqliteLayer = makeSqliteLayer(databaseNameFor(user.id));
  const protocolLayer = RpcClient.layerProtocolHttp({ url: rpcUrl }).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(RpcSerialization.layerNdjson),
  );
  return ManagedRuntime.make(
    clientLayer.pipe(Layer.provide(Layer.mergeAll(sessionLayer, sqliteLayer, protocolLayer))),
  );
}
