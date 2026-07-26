import { SqliteClient } from "@effect/sql-sqlite-wasm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import {
  CounterRepository,
  CounterRepositoryLive,
  type CounterSnapshot,
} from "./CounterRepository.ts";

const query = new URLSearchParams(location.search);
const databaseId = query.get("db") ?? "manual";
const tabId = query.get("tab") ?? crypto.randomUUID().slice(0, 8);
const channel = new BroadcastChannel(`plakk:sqlite-prototype:${databaseId}`);
const app = document.querySelector<HTMLElement>("#app")!;

interface PrototypeState extends CounterSnapshot {
  readonly databaseId: string;
  readonly disposed: boolean;
  readonly error: string | null;
  readonly ready: boolean;
  readonly tabId: string;
}

let state: PrototypeState = {
  databaseId,
  disposed: false,
  error: null,
  migrationCount: 0,
  ready: false,
  tabId,
  value: 0,
};

const makeRuntime = () => {
  const sqliteLayer = SqliteClient.layer({
    worker: Effect.acquireRelease(
      Effect.sync(() => {
        const worker = new Worker(new URL("./sqlite-worker.ts", import.meta.url), {
          name: databaseId,
          type: "module",
        });
        worker.addEventListener("error", (event) => recordError(event.message));
        return worker;
      }),
      (worker) => Effect.sync(() => worker.terminate()),
    ),
  });
  return ManagedRuntime.make(CounterRepositoryLive.pipe(Layer.provideMerge(sqliteLayer)));
};

let runtime: ReturnType<typeof makeRuntime> | null = makeRuntime();

const repositoryEffect = Effect.flatMap(CounterRepository, Effect.succeed);

const withRepository = async <A>(
  use: (repository: CounterRepository["Service"]) => Effect.Effect<A, unknown>,
): Promise<A> => {
  if (runtime === null) throw new Error("Runtime is disposed");
  return runtime.runPromise(Effect.flatMap(repositoryEffect, use));
};

const render = () => {
  app.innerHTML = `
    <style>
      :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
      body { margin: 0; }
      main { box-sizing: border-box; display: grid; gap: 1rem; margin: 3rem auto; max-width: 44rem; padding: 1.5rem; }
      section { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: .75rem; padding: 1rem; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; margin: 0; }
      dd { margin: 0; font-family: ui-monospace, monospace; }
      nav { display: flex; flex-wrap: wrap; gap: .5rem; }
      button, a { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: .5rem; color: inherit; padding: .55rem .75rem; text-decoration: none; }
      button { background: transparent; cursor: pointer; font: inherit; }
      button:disabled { cursor: not-allowed; opacity: .45; }
      .error { color: #dc2626; white-space: pre-wrap; }
    </style>
    <h1>Effect SQLite multi-tab prototype</h1>
    <section>
      <dl>
        <dt>Database</dt><dd>${state.databaseId}</dd>
        <dt>Tab</dt><dd>${state.tabId}</dd>
        <dt>Ready</dt><dd>${state.ready}</dd>
        <dt>Disposed</dt><dd>${state.disposed}</dd>
        <dt>Migrations</dt><dd>${state.migrationCount}</dd>
        <dt>Shared value</dt><dd>${state.value}</dd>
      </dl>
    </section>
    <nav>
      <button data-action="increment" ${state.disposed ? "disabled" : ""}>Increment</button>
      <button data-action="read" ${state.disposed ? "disabled" : ""}>Read</button>
      <button data-action="reset" ${state.disposed ? "disabled" : ""}>Reset</button>
      <button data-action="dispose" ${state.disposed ? "disabled" : ""}>Dispose worker</button>
      <button data-action="reopen" ${state.disposed ? "" : "disabled"}>Reopen worker</button>
      <a href="?db=${encodeURIComponent(databaseId)}&tab=second" target="_blank">Open second tab</a>
    </nav>
    ${state.error === null ? "" : `<p class="error">${state.error}</p>`}
  `;
};

const updateFromSnapshot = (snapshot: CounterSnapshot) => {
  state = { ...state, ...snapshot, error: null, ready: true };
  render();
};

const recordError = (cause: unknown) => {
  state = {
    ...state,
    error: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
  };
  render();
};

const read = async () => {
  const snapshot = await withRepository((repository) => repository.read);
  updateFromSnapshot(snapshot);
  return snapshot;
};

const increment = async () => {
  const value = await withRepository((repository) => repository.increment);
  state = { ...state, error: null, ready: true, value };
  render();
  channel.postMessage({ type: "changed" });
  return value;
};

const incrementMany = async (count: number) => {
  let value = state.value;
  for (let index = 0; index < count; index += 1) {
    value = await withRepository((repository) => repository.increment);
  }
  state = { ...state, error: null, ready: true, value };
  render();
  channel.postMessage({ type: "changed" });
  return value;
};

const reset = async () => {
  await withRepository((repository) => repository.reset);
  channel.postMessage({ type: "changed" });
  return read();
};

const dispose = async () => {
  if (runtime !== null) await runtime.dispose();
  runtime = null;
  state = { ...state, disposed: true, ready: false };
  render();
};

const reopen = async () => {
  if (runtime !== null) return read();
  runtime = makeRuntime();
  state = { ...state, disposed: false, error: null };
  render();
  return read();
};

channel.addEventListener("message", () => {
  if (runtime !== null) void read().catch(recordError);
});

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const operation =
    action === "increment"
      ? increment()
      : action === "read"
        ? read()
        : action === "reset"
          ? reset()
          : action === "dispose"
            ? dispose()
            : reopen();
  void operation.catch(recordError);
});

const api = {
  dispose,
  increment,
  incrementMany,
  read,
  reopen,
  reset,
  state: () => state,
};

declare global {
  interface Window {
    prototypeApi: typeof api;
  }
}

window.prototypeApi = api;
render();
void read().catch(recordError);
