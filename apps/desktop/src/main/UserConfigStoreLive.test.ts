import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";

import { UserConfigStore } from "./UserConfigStore.ts";

const persisted = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("electron-store", () => ({
  default: class {
    readonly defaults: Record<string, unknown>;

    constructor(options: { readonly defaults: Record<string, unknown> }) {
      this.defaults = options.defaults;
    }

    get store() {
      return { ...this.defaults, ...persisted.value };
    }

    set store(value: Record<string, unknown>) {
      persisted.value = value;
    }
  },
}));

const { UserConfigStoreLive } = await import("./UserConfigStoreLive.ts");

const readConfig = UserConfigStore.use((store) => store.get).pipe(
  Effect.provide(UserConfigStoreLive),
);

describe("UserConfigStoreLive", () => {
  beforeEach(() => {
    persisted.value = {};
  });

  it("keeps the current enabled Toolbar widget default for users without a saved preference", async () => {
    persisted.value = { showExternalLinkWarning: false };

    await expect(Effect.runPromise(readConfig)).resolves.toEqual({
      showExternalLinkWarning: false,
      toolbarWidgetEnabled: true,
    });
  });

  it("restores a disabled Toolbar widget after a new store layer is constructed", async () => {
    await Effect.runPromise(
      UserConfigStore.use((store) => store.set({ toolbarWidgetEnabled: false })).pipe(
        Effect.provide(UserConfigStoreLive),
      ),
    );

    await expect(Effect.runPromise(readConfig)).resolves.toEqual({
      showExternalLinkWarning: true,
      toolbarWidgetEnabled: false,
    });
  });
});
