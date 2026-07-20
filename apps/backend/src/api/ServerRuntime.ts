import { DrizzleLive, PgClientLive } from "@plakk/db";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { StorageProviderLive } from "./storage/StorageProviderLive.ts";
import { SnippetUploadsLive } from "./snippets/SnippetUploadsLive.ts";

const InfrastructureLive = Layer.mergeAll(DrizzleLive, PgClientLive, StorageProviderLive).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
);

const BackendServicesLive = SnippetUploadsLive.pipe(Layer.provideMerge(InfrastructureLive));

export const ServerRuntimeLive = BackendServicesLive;
