import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { app, net } from "electron";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { AuthServiceLive } from "./auth/AuthServiceLive.ts";
import { AuthStoreLive } from "./auth/AuthStoreLive.ts";
import { LocalStateLive } from "./local-state/LocalStateLive.ts";
import { LocalStateSnippetsLive } from "./local-state/LocalStateSnippetsLive.ts";
import { LocalStateStoreLive } from "./local-state/LocalStateStoreLive.ts";
import { PlakkRpcClientLive, plakkRpcProtocolLayer } from "./PlakkRpcClientLive.ts";
import { DesktopAccountDataLive } from "./session/DesktopAccountDataLive.ts";
import { DesktopSessionLive } from "./session/DesktopSessionLive.ts";
import { makeManagedSnippetContentLive } from "./snippets/content/ManagedSnippetContentLive.ts";
import { SnippetHydrationLive } from "./snippets/hydration/SnippetHydrationLive.ts";
import { SnippetHydrationTransportLive } from "./snippets/hydration/SnippetHydrationTransportLive.ts";
import { makeSnippetRemoteTransportLive } from "./snippets/replica/SnippetRemoteTransportLive.ts";
import { SnippetReplicaLive } from "./snippets/replica/SnippetReplicaLive.ts";
import { NativeFileSourcesLive } from "./snippets/sources/NativeFileSourcesLive.ts";
import { SnippetUploadEngineLive } from "./snippets/upload/SnippetUploadEngineLive.ts";
import { SnippetUploadOutboxLive } from "./snippets/upload/SnippetUploadOutboxLive.ts";
import { SnippetUploadRemoteLive } from "./snippets/upload/SnippetUploadRemoteLive.ts";
import { makeStorageUploadLive } from "./snippets/upload/StorageUploadLive.ts";
import { UserConfigStoreLive } from "./UserConfigStoreLive.ts";

export const managedSnippetContentRoot = join(app.getPath("userData"), "snippet-content");
const platformLayer = NodeFileSystem.layer;
const authServiceLayer = AuthServiceLive.pipe(Layer.provideMerge(AuthStoreLive));
const nativeFileSourcesLayer = NativeFileSourcesLive.pipe(Layer.provide(NodeCrypto.layer));
const managedSnippetContentLayer = makeManagedSnippetContentLive(managedSnippetContentRoot).pipe(
  Layer.provide(platformLayer),
);
const storageUploadLayer = makeStorageUploadLive((input, init) => net.fetch(input, init)).pipe(
  Layer.provide(platformLayer),
);
const plakkRpcClientLayer = PlakkRpcClientLive.pipe(Layer.provide(plakkRpcProtocolLayer));
const snippetRemoteTransportLayer = makeSnippetRemoteTransportLive((input, init) =>
  net.fetch(input instanceof URL ? input.toString() : input, init),
).pipe(Layer.provide(plakkRpcClientLayer));
const snippetUploadRemoteLayer = SnippetUploadRemoteLive.pipe(Layer.provide(plakkRpcClientLayer));
const uploadEngineDependencies = Layer.mergeAll(
  managedSnippetContentLayer,
  SnippetUploadOutboxLive,
  snippetUploadRemoteLayer,
  storageUploadLayer,
);
const snippetUploadEngineLayer = SnippetUploadEngineLive.pipe(
  Layer.provide(uploadEngineDependencies),
);
const snippetReplicaLayer = SnippetReplicaLive;
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
      managedSnippetContentLayer,
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
      managedSnippetContentLayer,
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
  UserConfigStoreLive,
  authServiceLayer,
  snippetReplicaLayer,
  plakkRpcClientLayer,
  platformLayer,
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
