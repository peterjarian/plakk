import { Drizzle, PgClientLive } from "@plakk/db";
import * as Layer from "effect/Layer";

import { StorageProviderService } from "./storage/StorageProvider.ts";
import { SnippetUploads } from "./SnippetUploads.ts";

const InfrastructureLive = Layer.mergeAll(Drizzle.Live, PgClientLive, StorageProviderService.Live);

export const ServerRuntimeLive = SnippetUploads.Live.pipe(Layer.provideMerge(InfrastructureLive));
