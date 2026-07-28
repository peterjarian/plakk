import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { app } from "electron";
import { join, resolve } from "node:path";
import { Config, Effect, FileSystem, Layer, ManagedRuntime, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { AuthServiceLive } from "./auth/AuthServiceLive.ts";
import { AuthStoreLive } from "./auth/AuthStore.ts";
import { DesktopSessionLive } from "./auth/DesktopSession.ts";
import { makeDesktopSqliteLayer } from "./Sqlite.ts";
import { makeDesktopContentStoreLayer } from "./snippets/DesktopContentStore.ts";
import { NativeFileSources } from "./snippets/NativeFileSources.ts";
import { UserConfigStoreLive } from "./UserConfigStore.ts";

const platformLayer = NodeFileSystem.layer;
const configuredUserDataPath = Effect.runSync(
  Config.option(Config.string("PLAKK_DESKTOP_USER_DATA_PATH")),
);
if (Option.isSome(configuredUserDataPath)) {
  const configuredPath = configuredUserDataPath.value.trim();
  const userDataPath = configuredPath ? resolve(configuredPath) : app.getPath("userData");
  await Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(userDataPath, { recursive: true });
    }).pipe(Effect.provide(platformLayer), Effect.orDie),
  );
  app.setPath("userData", userDataPath);
}
export const desktopContentRoot = join(app.getPath("userData"), "snippet-content");
export const desktopDatabasePath = join(app.getPath("userData"), "plakk.sqlite");
const authServiceLayer = AuthServiceLive.pipe(Layer.provideMerge(AuthStoreLive));
const nativeFileSourcesLayer = NativeFileSources.layer.pipe(Layer.provide(NodeCrypto.layer));
const desktopContentLayer = makeDesktopContentStoreLayer(desktopContentRoot).pipe(
  Layer.provide(platformLayer),
);
const plakkRpcProtocolLayer = Layer.unwrap(
  Config.url("PLAKK_RPC_URL").pipe(
    Effect.orDie,
    Effect.map((url) =>
      RpcClient.layerProtocolHttp({ url: url.toString() }).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(RpcSerialization.layerNdjson),
      ),
    ),
  ),
);
const desktopSqliteLayer = makeDesktopSqliteLayer(desktopDatabasePath);
const desktopSessionLayer = DesktopSessionLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      authServiceLayer,
      nativeFileSourcesLayer,
      platformLayer,
      desktopContentLayer,
      desktopSqliteLayer,
      plakkRpcProtocolLayer,
    ),
  ),
);

const MainLayer = Layer.mergeAll(
  UserConfigStoreLive,
  authServiceLayer,
  platformLayer,
  desktopContentLayer,
  nativeFileSourcesLayer,
  desktopSessionLayer,
);

export const runtime = ManagedRuntime.make(MainLayer);

export const runEffect = runtime.runPromise;
