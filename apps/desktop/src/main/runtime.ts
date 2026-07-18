import { NodeFileSystem } from "@effect/platform-node";
import { app, net } from "electron";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { StorageUpload } from "../storageUpload.ts";
import { SnippetHydrationEngine } from "@plakk/shared/SnippetHydration";
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
import { SnippetHydrationTransportLive } from "./SnippetHydrationTransport.ts";
import {
  DesktopProjection,
  DesktopProjectionStore,
  DesktopSnippetProjector,
} from "./DesktopProjection.ts";
import { DesktopAccountData } from "./DesktopAccountData.ts";
import { NativeFileSources } from "./NativeFileSources.ts";
import { DesktopSession } from "./DesktopSession.ts";

export const managedSnippetContentRoot = join(app.getPath("userData"), "snippet-content");
const platformLayer = NodeFileSystem.layer;
const authServiceLayer = AuthService.layer.pipe(Layer.provideMerge(AuthStore.Live));
const nativeFileSourcesLayer = NativeFileSources.Live;
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
  SnippetReplicaLive,
  SnippetUploadOutbox.Live,
  snippetUploadRemoteLayer,
  storageUploadLayer,
);
const hydrationEngineDependencies = Layer.mergeAll(
  managedSnippetContentLayer,
  SnippetReplicaLive,
  SnippetHydrationTransportLive.pipe(Layer.provide(plakkRpcClientLayer)),
);
const snippetUploadEngineLayer = SnippetUploadEngine.Live.pipe(
  Layer.provide(uploadEngineDependencies),
);
const snippetHydrationEngineLayer = SnippetHydrationEngine.Live.pipe(
  Layer.provide(hydrationEngineDependencies),
);
const desktopSnippetProjectorLayer = DesktopSnippetProjector.Live.pipe(
  Layer.provide(
    Layer.mergeAll(
      SnippetReplicaLive,
      snippetUploadEngineLayer,
      snippetHydrationEngineLayer,
      desktopContentLayer,
    ),
  ),
);
const desktopProjectionLayer = DesktopProjection.layer.pipe(
  Layer.provide(Layer.merge(DesktopProjectionStore.Live, desktopSnippetProjectorLayer)),
);
const desktopAccountDataLayer = DesktopAccountData.Live.pipe(
  Layer.provide(
    Layer.mergeAll(
      SnippetReplicaLive,
      snippetUploadEngineLayer,
      SnippetUploadOutbox.Live,
      snippetHydrationEngineLayer,
      desktopContentLayer,
      desktopProjectionLayer,
    ),
  ),
);
const desktopSessionLayer = DesktopSession.Live.pipe(
  Layer.provide(
    Layer.mergeAll(
      authServiceLayer,
      desktopAccountDataLayer,
      desktopProjectionLayer,
      nativeFileSourcesLayer,
      snippetUploadEngineLayer,
      snippetHydrationEngineLayer,
      UserConfigStore.Live,
      SnippetReplicaLive,
      snippetRemoteTransportLayer,
      managedSnippetContentLayer,
      plakkRpcClientLayer,
    ),
  ),
);

const MainLayer = Layer.mergeAll(
  UserConfigStore.Live,
  authServiceLayer,
  SnippetReplicaLive,
  plakkRpcClientLayer,
  platformLayer,
  desktopContentLayer,
  managedSnippetContentLayer,
  snippetRemoteTransportLayer,
  storageUploadLayer,
  snippetUploadEngineLayer,
  snippetHydrationEngineLayer,
  desktopSnippetProjectorLayer,
  desktopProjectionLayer,
  desktopAccountDataLayer,
  nativeFileSourcesLayer,
  desktopSessionLayer,
);

export const runtime = ManagedRuntime.make(MainLayer);

export const runEffect = runtime.runPromise;
