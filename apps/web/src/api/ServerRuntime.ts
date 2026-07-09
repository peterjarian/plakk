import { Drizzle } from "@plakk/db";
import * as Layer from "effect/Layer";

export const ServerRuntimeLive = Layer.mergeAll(Drizzle.Live);
