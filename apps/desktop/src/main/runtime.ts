import { NodeFileSystem } from "@effect/platform-node";
import { app, net } from "electron";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { StorageUpload } from "../storageUpload.ts";
import { SnippetHydrationEngine } from "@plakk/shared/SnippetHydration";
import { AuthService } from "./auth/AuthService.ts";
import { AuthStore } from "./auth/AuthStore.ts";
import { UserConfigStore } from "./UserConfigStore.ts";
import {
  ActiveSnippetAccountLive,
  SnippetRemoteTransportLive,
  SnippetReplicaLive,
} from "./snippetReplica.ts";
import {
  DesktopManagedSnippetContent,
  managedSnippetContentFromDesktopLayer,
} from "./ManagedSnippetContent.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";
import { SnippetUploadOutbox } from "./SnippetUploadOutbox.ts";
import { SnippetUploadRemote } from "./SnippetUploadRemote.ts";
import { PlakkRpcClient, plakkRpcProtocolLayer } from "./PlakkRpcClient.ts";
import { SnippetHydrationTransportLive } from "./SnippetHydrationTransport.ts";

export const managedSnippetContentRoot = join(app.getPath("userData"), "snippet-content");
const platformLayer = NodeFileSystem.layer;
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

const MainLayer = Layer.mergeAll(
  UserConfigStore.Live,
  AuthService.layer.pipe(Layer.provideMerge(AuthStore.Live)),
  ActiveSnippetAccountLive,
  SnippetReplicaLive,
  plakkRpcClientLayer,
  platformLayer,
  desktopContentLayer,
  managedSnippetContentLayer,
  snippetRemoteTransportLayer,
  storageUploadLayer,
  SnippetUploadEngine.Live.pipe(Layer.provide(uploadEngineDependencies)),
  SnippetHydrationEngine.Live.pipe(Layer.provide(hydrationEngineDependencies)),
);

export const runtime = ManagedRuntime.make(MainLayer);

export const runEffect = runtime.runPromise;
