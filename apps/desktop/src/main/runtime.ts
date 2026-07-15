import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { net } from "electron";
import { Layer, ManagedRuntime } from "effect";
import { StorageUpload } from "../storageUpload.ts";
import { AuthService } from "./auth/AuthService.ts";
import { AuthStore } from "./auth/AuthStore.ts";
import { UserConfigStore } from "./UserConfigStore.ts";
import {
  ActiveSnippetAccountLive,
  ManagedSnippetContentLive,
  SnippetRemoteTransportLive,
  SnippetReplicaLive,
} from "./snippetReplica.ts";

const MainLayer = Layer.mergeAll(
  UserConfigStore.Live,
  AuthService.layer.pipe(Layer.provideMerge(AuthStore.Live)),
  ActiveSnippetAccountLive,
  SnippetReplicaLive,
  ManagedSnippetContentLive.pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  ),
  SnippetRemoteTransportLive,
  StorageUpload.layer((input, init) => net.fetch(input, init)),
);

export const runtime = ManagedRuntime.make(MainLayer);

export const runEffect = runtime.runPromise;
