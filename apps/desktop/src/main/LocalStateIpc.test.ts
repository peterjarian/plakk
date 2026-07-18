import { NodeFileSystem } from "@effect/platform-node";
import type { User } from "@plakk/shared";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, ManagedRuntime, Stream } from "effect";
import { vi } from "vite-plus/test";

const electron = vi.hoisted(() => {
  type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
  type Listener = (event: unknown, payload: unknown) => void;
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Set<Listener>>();
  let holdLocalStateGet = false;
  const releaseLocalStateGets: Array<() => void> = [];

  return {
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcMain: {
      handle: vi.fn((channel: string, handler: Handler) => void handlers.set(channel, handler)),
    },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, payload: unknown) => {
        const result = await handlers.get(channel)?.({}, payload);
        if (channel === "local-state:get" && holdLocalStateGet) {
          await new Promise<void>((resolve) => {
            releaseLocalStateGets.push(resolve);
          });
        }
        return result;
      }),
      on: vi.fn((channel: string, listener: Listener) => {
        const registered = listeners.get(channel) ?? new Set<Listener>();
        registered.add(listener);
        listeners.set(channel, registered);
      }),
      off: vi.fn((channel: string, listener: Listener) => listeners.get(channel)?.delete(listener)),
    },
    holdGet: () => {
      holdLocalStateGet = true;
    },
    releaseGet: () => {
      holdLocalStateGet = false;
      for (const release of releaseLocalStateGets.splice(0)) release();
    },
    send: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
    webUtils: { getPathForFile: vi.fn() },
  };
});

vi.mock("electron", () => ({
  contextBridge: electron.contextBridge,
  ipcMain: electron.ipcMain,
  ipcRenderer: electron.ipcRenderer,
  webUtils: electron.webUtils,
}));

import { ipcEvents, ipcMethods, type LocalState as LocalStateValue } from "../ipc/contracts.ts";
import { makeHandle, send } from "../ipc/main.ts";
import { desktopApi } from "../preload/index.ts";
import {
  initialLocalStateSubscription,
  subscribeToLocalState,
  updateLocalStateSubscription,
} from "../renderer/hooks/useLocalState.tsx";
import { LocalStateLive } from "./Layers/LocalState.ts";
import { makeLocalStateStoreLive } from "./Layers/LocalStateStore.ts";
import { LocalState, LocalStateSnippets } from "./Services/LocalState.ts";

const account: User = {
  id: "user_1",
  email: "reader@example.com",
  firstName: "Offline",
  lastName: "Reader",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("Local State IPC", () => {
  it.effect("keeps two renderer surfaces consistent across the initial get/subscription race", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plakk-local-state-ipc-" });
      const runtime = ManagedRuntime.make(
        LocalStateLive.pipe(
          Layer.provide(
            Layer.merge(
              makeLocalStateStoreLive({ cwd }),
              Layer.succeed(
                LocalStateSnippets,
                LocalStateSnippets.of({ changes: Stream.empty, read: () => Effect.succeed([]) }),
              ),
            ),
          ),
        ),
      );
      const handle = makeHandle(runtime);
      handle(ipcMethods.localStateGet, () => LocalState.use((localState) => localState.current));
      const target = { send: electron.send };
      runtime.runFork(
        LocalState.use((localState) =>
          localState.changes.pipe(
            Stream.runForEach((value) =>
              Effect.sync(() => send(target as never, ipcEvents.localStateChanged, value)),
            ),
          ),
        ),
      );

      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) => localState.update({ kind: "offline", account })),
        ),
      );
      yield* Effect.yieldNow;

      let home = initialLocalStateSubscription;
      let tray = initialLocalStateSubscription;
      const subscribe = (read: () => typeof home, write: (next: typeof home) => void) =>
        subscribeToLocalState(
          (action) => write(updateLocalStateSubscription(read(), action)),
          desktopApi.localState,
        );

      electron.holdGet();
      const homeSubscription = subscribe(
        () => home,
        (next) => void (home = next),
      );
      const traySubscription = subscribe(
        () => tray,
        (next) => void (tray = next),
      );
      yield* Effect.yieldNow;

      yield* Effect.promise(() =>
        runtime.runPromise(
          LocalState.use((localState) =>
            localState.update({
              kind: "online",
              account,
              accountStatus: {
                canSync: true,
                storageProvider: "GOOGLE_DRIVE",
                blockedReasons: [],
              },
              connection: {
                storageProvider: "GOOGLE_DRIVE",
                status: "CONNECTED",
                externalDestinationUrl: "https://drive.example.com/folder",
              },
            }),
          ),
        ),
      );
      yield* Effect.promise(() => vi.waitFor(() => expect(home.localState.revision).toBe(2)));
      yield* Effect.promise(() => vi.waitFor(() => expect(tray.localState.revision).toBe(2)));

      electron.releaseGet();
      yield* Effect.promise(() =>
        Promise.all([homeSubscription.initial, traySubscription.initial]),
      );

      const expected: Partial<LocalStateValue> = {
        revision: 2,
        account,
        provider: { known: true, value: "GOOGLE_DRIVE" },
      };
      expect(home.localState).toMatchObject(expected);
      expect(tray.localState).toMatchObject(expected);
      expect(tray.localState).toEqual(home.localState);

      homeSubscription.unsubscribe();
      traySubscription.unsubscribe();
      yield* Effect.promise(() => runtime.dispose());
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
