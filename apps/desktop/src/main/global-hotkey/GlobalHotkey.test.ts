import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type { UserConfig } from "../../ipc/contracts.ts";
import { UserConfigStore } from "../UserConfigStore.ts";
import {
  GlobalHotkey,
  makeGlobalHotkeyLive,
  portableHotkeyToElectronAccelerator,
  type GlobalHotkeyPlatform,
} from "./GlobalHotkey.ts";

const initialConfig: UserConfig = {
  appearance: "system",
  showExternalLinkWarning: true,
  globalHotkey: {
    enabled: true,
    shortcut: "Mod+Shift+V",
  },
};

function makeHarness(
  options: {
    readonly blocked?: ReadonlySet<string>;
    readonly initial?: UserConfig;
    readonly throwing?: ReadonlySet<string>;
  } = {},
) {
  let config = structuredClone(options.initial ?? initialConfig);
  const blocked = options.blocked ?? new Set<string>();
  const throwing = options.throwing ?? new Set<string>();
  const callbacks = new Map<string, () => void>();
  const calls: Array<string> = [];
  const reveal = vi.fn();
  const platform: GlobalHotkeyPlatform = {
    register: (accelerator, callback) => {
      calls.push(`register:${accelerator}`);
      if (throwing.has(accelerator)) throw new Error("native registration failed");
      if (blocked.has(accelerator)) return false;
      callbacks.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator) => {
      calls.push(`unregister:${accelerator}`);
      callbacks.delete(accelerator);
    },
  };
  const storeLayer = Layer.succeed(
    UserConfigStore,
    UserConfigStore.of({
      get: Effect.sync(() => structuredClone(config)),
      reset: Effect.sync(() => {
        config = structuredClone(initialConfig);
        return structuredClone(config);
      }),
      set: (patch) =>
        Effect.sync(() => {
          config = {
            ...config,
            ...patch,
            globalHotkey:
              patch.globalHotkey === undefined
                ? config.globalHotkey
                : { ...config.globalHotkey, ...patch.globalHotkey },
          };
          return structuredClone(config);
        }),
    }),
  );

  return {
    callbacks,
    calls,
    config: () => config,
    layer: makeGlobalHotkeyLive(platform, "linux").pipe(Layer.provide(storeLayer)),
    reveal,
  };
}

describe("GlobalHotkey", () => {
  it("converts portable TanStack hotkeys into Electron accelerators", () => {
    expect(portableHotkeyToElectronAccelerator("Mod+Shift+ArrowUp", "linux")).toBe(
      "Control+Shift+Up",
    );
    expect(portableHotkeyToElectronAccelerator("Mod+Alt+Space", "mac")).toBe("Alt+Meta+Space");
    expect(portableHotkeyToElectronAccelerator("Control+Meta+F8", "windows")).toBe(
      "Control+Meta+F8",
    );
  });

  it.effect("restores the saved default at startup and reveals Plakk when invoked", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hotkey = yield* GlobalHotkey;

      const status = yield* hotkey.start(harness.reveal);

      expect(status).toEqual({ ...initialConfig.globalHotkey, errorMessage: null });
      expect(harness.callbacks.has("Control+Shift+V")).toBe(true);
      harness.callbacks.get("Control+Shift+V")?.();
      expect(harness.reveal).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("replaces, disables, and restores the active shortcut immediately", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hotkey = yield* GlobalHotkey;
      yield* hotkey.start(harness.reveal);

      const replaced = yield* hotkey.update({ shortcut: "Control+Alt+F8" });
      expect(replaced).toEqual({
        enabled: true,
        shortcut: "Mod+Alt+F8",
        errorMessage: null,
      });
      expect(harness.calls).toEqual([
        "register:Control+Shift+V",
        "register:Control+Alt+F8",
        "unregister:Control+Shift+V",
      ]);
      expect(harness.callbacks.has("Control+Alt+F8")).toBe(true);

      yield* hotkey.update({ enabled: false });
      expect(harness.callbacks.size).toBe(0);
      expect(harness.config().globalHotkey.enabled).toBe(false);

      yield* hotkey.update({ enabled: true });
      expect(harness.callbacks.has("Control+Alt+F8")).toBe(true);
      expect(harness.config().globalHotkey.enabled).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the previous working binding when replacement is unavailable", () => {
    const harness = makeHarness({ blocked: new Set(["Control+Alt+F8"]) });
    return Effect.gen(function* () {
      const hotkey = yield* GlobalHotkey;
      yield* hotkey.start(harness.reveal);

      const status = yield* hotkey.update({ shortcut: "Control+Alt+F8" });

      expect(status.shortcut).toBe("Mod+Shift+V");
      expect(status.errorMessage).toContain("unavailable");
      expect(harness.config().globalHotkey.shortcut).toBe("Mod+Shift+V");
      expect(harness.callbacks.has("Control+Shift+V")).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("suspends the active binding while recording and restores it on cancellation", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hotkey = yield* GlobalHotkey;
      yield* hotkey.start(harness.reveal);

      yield* hotkey.beginRecording;
      expect(harness.callbacks.size).toBe(0);

      const status = yield* hotkey.cancelRecording;
      expect(status.errorMessage).toBeNull();
      expect(harness.callbacks.has("Control+Shift+V")).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("restores the old binding when a recorded replacement cannot register", () => {
    const harness = makeHarness({ blocked: new Set(["Control+Alt+F8"]) });
    return Effect.gen(function* () {
      const hotkey = yield* GlobalHotkey;
      yield* hotkey.start(harness.reveal);
      yield* hotkey.beginRecording;

      const status = yield* hotkey.update({ shortcut: "Control+Alt+F8" });

      expect(status).toEqual({
        ...initialConfig.globalHotkey,
        errorMessage: expect.stringContaining("unavailable"),
      });
      expect(harness.callbacks.has("Control+Shift+V")).toBe(true);
      expect(harness.config()).toEqual(initialConfig);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("preserves exceptional native registration errors and restores recording state", () => {
    const harness = makeHarness({ throwing: new Set(["Control+Alt+F8"]) });
    return Effect.gen(function* () {
      const hotkey = yield* GlobalHotkey;
      yield* hotkey.start(harness.reveal);
      yield* hotkey.beginRecording;

      const result = yield* Effect.result(hotkey.update({ shortcut: "Control+Alt+F8" }));

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "GlobalHotkeyError",
          reason: "Plakk could not register this shortcut. Try again.",
        },
      });
      expect(harness.callbacks.has("Control+Shift+V")).toBe(true);
      expect(harness.config()).toEqual(initialConfig);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("unregisters its active shortcut during cleanup", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hotkey = yield* GlobalHotkey;
      yield* hotkey.start(harness.reveal);

      yield* hotkey.stop;

      expect(harness.callbacks.size).toBe(0);
      expect(harness.calls.at(-1)).toBe("unregister:Control+Shift+V");
    }).pipe(Effect.provide(harness.layer));
  });
});
