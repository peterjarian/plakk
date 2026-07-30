// @vitest-environment happy-dom

import { Effect, Stream } from "effect";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  assign: vi.fn(),
  clearClientMetadata: vi.fn(),
  makeClientRuntime: vi.fn(),
}));

vi.mock("@workos/authkit-tanstack-react-start/client", () => ({
  useAccessToken: () => ({
    error: null,
    getAccessToken: () => Promise.resolve("access-token"),
  }),
}));

vi.mock("@plakk/client-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@plakk/client-runtime")>();
  return {
    ...actual,
    clearClientMetadata: state.clearClientMetadata,
  };
});

vi.mock("../runtime/client.ts", async () => {
  const { Layer } = await import("effect");
  return {
    databaseLockNameFor: (userId: string) => `database:${userId}`,
    databaseNameFor: (userId: string) => `database-${userId}`,
    makeClientRuntime: state.makeClientRuntime,
    makeSqliteLayer: () => Layer.empty,
    runtimeChannelNameFor: (userId: string) => `runtime:${userId}`,
  };
});

import { Client, LocalStorageError, type ClientSnapshot } from "@plakk/client-runtime";
import type { User } from "@plakk/shared";

import { useClientRuntime } from "./useClientRuntime.ts";

const user = {
  id: "user_1",
  email: "reader@example.com",
  firstName: "Plakk",
  lastName: "User",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies User;

const roots: Array<Root> = [];
let runtimeState: ReturnType<typeof useClientRuntime> | undefined;

class TestBroadcastChannel {
  addEventListener() {}
  close() {}
  postMessage() {}
}

function Harness() {
  runtimeState = useClientRuntime(user);
  return <div>{runtimeState.issue ?? "healthy"}</div>;
}

const deferred = () => {
  let reject!: (cause: unknown) => void;
  const promise = new Promise<never>((_, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
};

const runtimeWithSnapshot = (snapshot?: ClientSnapshot) => {
  const exit = deferred();
  const dispose = vi.fn(async () => exit.reject(new Error("Runtime disposed.")));
  return {
    dispose,
    runPromise: (effect: Effect.Effect<unknown, unknown, unknown>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(
            Client,
            Client.of({
              subscribe: () =>
                Stream.concat(
                  snapshot === undefined ? Stream.empty : Stream.make(snapshot),
                  Stream.fromEffect(
                    Effect.tryPromise({
                      try: () => exit.promise,
                      catch: (cause) => cause,
                    }),
                  ),
                ),
            } as never),
          ),
        ) as Effect.Effect<unknown, unknown>,
      ),
  };
};

const renderHarness = async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<Harness />));
  return container;
};

beforeEach(() => {
  runtimeState = undefined;
  state.assign.mockReset();
  state.clearClientMetadata.mockReset();
  state.clearClientMetadata.mockReturnValue(Effect.void);
  state.makeClientRuntime.mockReset();

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: TestBroadcastChannel,
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (
        _name: string,
        optionsOrCallback: object | ((lock: object) => Promise<unknown>),
        optionalCallback?: (lock: object) => Promise<unknown>,
      ) => {
        const callback =
          typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
        if (callback === undefined) throw new Error("Lock callback is missing.");
        return callback({});
      },
    },
  });
  vi.spyOn(window.location, "assign").mockImplementation(state.assign);
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("web client runtime lifecycle", () => {
  it("does not report intentional sign-out disposal as a startup failure", async () => {
    const exit = deferred();
    const dispose = vi.fn(async () => exit.reject(new Error("Runtime disposed.")));
    state.makeClientRuntime.mockReturnValue({
      dispose,
      runPromise: (effect: Effect.Effect<unknown, unknown, unknown>) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provideService(
              Client,
              Client.of({
                subscribe: () =>
                  Stream.fromEffect(
                    Effect.tryPromise({
                      try: () => exit.promise,
                      catch: (cause) => cause,
                    }),
                  ),
              } as never),
            ),
          ) as Effect.Effect<unknown, unknown>,
        ),
    });

    const container = await renderHarness();

    await act(async () => {
      await runtimeState?.signOut();
    });

    expect(dispose).toHaveBeenCalled();
    expect(container.textContent).toBe("healthy");
    expect(state.assign).toHaveBeenCalledWith("/api/auth/sign-out");
  });

  it("still reports an unexpected runtime rejection as a startup failure", async () => {
    state.makeClientRuntime.mockReturnValue({
      dispose: () => Promise.resolve(),
      runPromise: () => Promise.reject(new Error("Could not start.")),
    });

    const container = await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toBe("startup");
  });

  it("surfaces a backend-rejected session from the client snapshot", async () => {
    state.makeClientRuntime.mockReturnValue(
      runtimeWithSnapshot({
        user,
        capability: {
          status: "OFFLINE",
          storageProvider: { known: false, value: null },
        },
        syncStatus: "SESSION_ERROR",
        storageUsageBytes: 0,
        snippets: [],
      }),
    );

    const container = await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toBe("session");
  });

  it("waits for an occupied database lock and starts after it is released", async () => {
    let queuedCallback: ((lock: object) => Promise<unknown>) | undefined;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (
          _name: string,
          optionsOrCallback: object | ((lock: object) => Promise<unknown>),
          optionalCallback?: (lock: object | null) => Promise<unknown>,
        ) => {
          const callback =
            typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
          if (callback === undefined) throw new Error("Lock callback is missing.");
          if (typeof optionsOrCallback === "object" && "ifAvailable" in optionsOrCallback) {
            return callback(null);
          }
          queuedCallback = callback as (lock: object) => Promise<unknown>;
          return new Promise(() => {});
        },
      },
    });
    state.makeClientRuntime.mockReturnValue(
      runtimeWithSnapshot({
        user,
        capability: {
          status: "OFFLINE",
          storageProvider: { known: false, value: null },
        },
        syncStatus: "CONNECTED",
        storageUsageBytes: 0,
        snippets: [],
      }),
    );

    const container = await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toBe("another-tab");

    await act(async () => {
      void queuedCallback?.({}).catch(() => {});
      await Promise.resolve();
    });
    expect(container.textContent).toBe("healthy");
  });

  it("reports sign-out cleanup failures instead of navigating away", async () => {
    state.makeClientRuntime.mockReturnValue(runtimeWithSnapshot());
    state.clearClientMetadata.mockReturnValue(
      Effect.fail(
        new LocalStorageError({
          message: "Could not clear metadata.",
        }),
      ),
    );
    await renderHarness();

    await expect(
      act(async () => {
        await runtimeState?.signOut();
      }),
    ).rejects.toMatchObject({ _tag: "LocalStorageError" });

    expect(state.assign).not.toHaveBeenCalled();
  });
});
