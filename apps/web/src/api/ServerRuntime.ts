import { Drizzle, PgClientLive } from "@plakk/db";
import * as Layer from "effect/Layer";

import { StorageProviderService } from "./storage/StorageProvider.ts";

export const ServerRuntimeLive = Layer.mergeAll(
  Drizzle.Live,
  PgClientLive,
  StorageProviderService.Live,
);
