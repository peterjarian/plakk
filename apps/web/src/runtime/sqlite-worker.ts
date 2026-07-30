/// <reference lib="webworker" />

import { OpfsWorker } from "@effect/sql-sqlite-wasm";
import { Effect } from "effect";

const worker = self as DedicatedWorkerGlobalScope;

void Effect.runPromise(
  OpfsWorker.run({
    port: worker,
    dbName: worker.name,
  }),
);
