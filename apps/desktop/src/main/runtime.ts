import { NodeFileSystem } from "@effect/platform-node";
import { app, net } from "electron";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { StorageUpload } from "../storageUpload.ts";
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
  ManagedSnippetContentLive,
} from "./ManagedSnippetContent.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";
import { SnippetUploadOutbox } from "./SnippetUploadOutbox.ts";
import { SnippetUploadRemote } from "./SnippetUploadRemote.ts";

export const managedSnippetContentRoot = join(app.getPath("userData"), "snippet-content");
const platformLayer = NodeFileSystem.layer;
const desktopContentLayer = DesktopManagedSnippetContent.layer(managedSnippetContentRoot).pipe(
  Layer.provide(platformLayer),
);
const storageUploadLayer = StorageUpload.layer((input, init) => net.fetch(input, init)).pipe(
  Layer.provide(platformLayer),
);
const uploadEngineDependencies = Layer.mergeAll(
  desktopContentLayer,
  SnippetUploadOutbox.Live,
  SnippetUploadRemote.Live,
  storageUploadLayer,
);

const MainLayer = Layer.mergeAll(
  UserConfigStore.Live,
  AuthService.layer.pipe(Layer.provideMerge(AuthStore.Live)),
  ActiveSnippetAccountLive,
  SnippetReplicaLive,
  platformLayer,
  desktopContentLayer,
  ManagedSnippetContentLive.pipe(Layer.provide(desktopContentLayer)),
  SnippetRemoteTransportLive,
  storageUploadLayer,
  SnippetUploadEngine.Live.pipe(Layer.provide(uploadEngineDependencies)),
);

export const runtime = ManagedRuntime.make(MainLayer);

export const runEffect = runtime.runPromise;
