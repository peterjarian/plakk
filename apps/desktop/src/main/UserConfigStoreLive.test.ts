import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const stores = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("electron-store", () => ({
  default: class ElectronStore {
    readonly name: string;

    constructor(options: { defaults: Record<string, unknown>; name: string }) {
      this.name = options.name;
      if (!stores.has(this.name)) stores.set(this.name, { ...options.defaults });
    }

    get store() {
      return stores.get(this.name) ?? {};
    }

    set store(value: Record<string, unknown>) {
      stores.set(this.name, { ...value });
    }
  },
}));

import { UserConfigStore } from "./UserConfigStore.ts";
import { UserConfigStoreLive } from "./UserConfigStoreLive.ts";

const runWithStore = <A>(effect: Effect.Effect<A, unknown, UserConfigStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(UserConfigStoreLive)));

describe("desktop user config persistence", () => {
  beforeEach(() => stores.clear());

  it("defaults missing appearance choices to System", async () => {
    stores.set("user-config", { showExternalLinkWarning: false });

    await expect(runWithStore(UserConfigStore.use((store) => store.get))).resolves.toEqual({
      appearance: "system",
      showExternalLinkWarning: false,
    });
  });

  it("restores an explicit appearance after recreating the store", async () => {
    await runWithStore(UserConfigStore.use((store) => store.set({ appearance: "dark" })));

    await expect(runWithStore(UserConfigStore.use((store) => store.get))).resolves.toEqual({
      appearance: "dark",
      showExternalLinkWarning: true,
    });
  });
});
