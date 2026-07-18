import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { app, net } from "electron";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { StorageUpload } from "../storageUpload.ts";
import { AuthService } from "./auth/AuthService.ts";
import { AuthStore } from "./auth/AuthStore.ts";
import { UserConfigStore } from "./UserConfigStore.ts";
import { SnippetRemoteTransportLive, SnippetReplicaLive } from "./snippetReplica.ts";
import {
  DesktopManagedSnippetContent,
  managedSnippetContentFromDesktopLayer,
} from "./ManagedSnippetContent.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";
import { SnippetUploadOutbox } from "./SnippetUploadOutbox.ts";
import { SnippetUploadRemote } from "./SnippetUploadRemote.ts";
import { PlakkRpcClient, plakkRpcProtocolLayer } from "./PlakkRpcClient.ts";
import { SnippetHydrationLive } from "./Layers/SnippetHydration.ts";
import { SnippetHydrationTransportLive } from "./Layers/SnippetHydrationTransport.ts";
import { LocalStateLive } from "./Layers/LocalState.ts";
import { LocalStateSnippetsLive } from "./Layers/LocalStateSnippets.ts";
import { LocalStateStoreLive } from "./Layers/LocalStateStore.ts";
import { DesktopAccountDataLive } from "./Layers/DesktopAccountData.ts";
import { NativeFileSourcesLive } from "./Layers/NativeFileSources.ts";
import { DesktopSessionLive } from "./Layers/DesktopSession.ts";
import { SnippetReplicaWithUploadCleanupLive } from "./Layers/SnippetReplica.ts";

export const managedSnippetContentRoot = join(app.getPath("userData"), "snippet-content");
const platformLayer = NodeFileSystem.layer;
const authServiceLayer = AuthService.layer.pipe(Layer.provideMerge(AuthStore.Live));
const nativeFileSourcesLayer = NativeFileSourcesLive.pipe(Layer.provide(NodeCrypto.layer));
const desktopContentLayer = DesktopManagedSnippetContent.layer(managedSnippetContentRoot).pipe(
  Layer.provide(platformLayer),
);
const storageUploadLayer = StorageUpload.layer((input, init) => net.fetch(input, init)).pipe(
  Layer.provide(platformLayer),
);
const plakkRpcClientLayer = PlakkRpcClient.layer.pipe(Layer.provide(plakkRpcProtocolLayer));
const snippetRemoteTransportLayer = SnippetRemoteTransportLive.pipe(
  Layer.provide(plakkRpcClientLayer),
);
const snippetUploadRemoteLayer = SnippetUploadRemote.Live.pipe(Layer.provide(plakkRpcClientLayer));
const managedSnippetContentLayer = managedSnippetContentFromDesktopLayer.pipe(
  Layer.provide(desktopContentLayer),
);
const uploadEngineDependencies = Layer.mergeAll(
  desktopContentLayer,
  SnippetUploadOutbox.Live,
  snippetUploadRemoteLayer,
  storageUploadLayer,
);
const snippetUploadEngineLayer = SnippetUploadEngine.Live.pipe(
  Layer.provide(uploadEngineDependencies),
);
const snippetReplicaLayer = SnippetReplicaWithUploadCleanupLive.pipe(
  Layer.provide(Layer.merge(SnippetReplicaLive, snippetUploadEngineLayer)),
);
const hydrationEngineDependencies = Layer.mergeAll(
  managedSnippetContentLayer,
  snippetReplicaLayer,
  SnippetHydrationTransportLive.pipe(Layer.provide(plakkRpcClientLayer)),
);
const snippetHydrationEngineLayer = SnippetHydrationLive.pipe(
  Layer.provide(hydrationEngineDependencies),
);
const localStateSnippetsLayer = LocalStateSnippetsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      snippetReplicaLayer,
      snippetUploadEngineLayer,
      snippetHydrationEngineLayer,
      desktopContentLayer,
    ),
  ),
);
const localStateLayer = LocalStateLive.pipe(
  Layer.provide(Layer.merge(LocalStateStoreLive, localStateSnippetsLayer)),
);
const desktopAccountDataLayer = DesktopAccountDataLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      snippetReplicaLayer,
      snippetUploadEngineLayer,
      snippetHydrationEngineLayer,
      desktopContentLayer,
      localStateLayer,
    ),
  ),
);
const desktopSessionLayer = DesktopSessionLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      authServiceLayer,
      desktopAccountDataLayer,
      localStateLayer,
      nativeFileSourcesLayer,
      snippetUploadEngineLayer,
      snippetHydrationEngineLayer,
      platformLayer,
      snippetReplicaLayer,
      snippetRemoteTransportLayer,
      managedSnippetContentLayer,
      plakkRpcClientLayer,
    ),
  ),
);

const MainLayer = Layer.mergeAll(
  UserConfigStore.Live,
  authServiceLayer,
  snippetReplicaLayer,
  plakkRpcClientLayer,
  platformLayer,
  desktopContentLayer,
  managedSnippetContentLayer,
  snippetRemoteTransportLayer,
  storageUploadLayer,
  snippetUploadEngineLayer,
  snippetHydrationEngineLayer,
  localStateSnippetsLayer,
  localStateLayer,
  desktopAccountDataLayer,
  nativeFileSourcesLayer,
  desktopSessionLayer,
);

export const runtime = ManagedRuntime.make(MainLayer);

export const runEffect = runtime.runPromise;
