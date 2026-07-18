import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  getStatus: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useCallback: <A,>(value: A) => value,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) state.effects.push(cleanup);
    },
    useMemo: <A,>(make: () => A) => make(),
    useState: <A,>(initial: A | (() => A)) => [
      typeof initial === "function" ? (initial as () => A)() : initial,
      vi.fn(),
    ],
  };
});

vi.mock("./useAuth.ts", () => ({
  useAuth: () => ({ user: { id: "user_1" } }),
}));

describe("StorageStatusProvider", () => {
  beforeEach(() => {
    vi.resetModules();
    state.effects.length = 0;
    state.getStatus.mockReset();
    state.getStatus.mockResolvedValue({
      account: { canSync: true, storageProvider: "GOOGLE_DRIVE", blockedReasons: [] },
      connection: {
        storageProvider: "GOOGLE_DRIVE",
        status: "CONNECTED",
        externalDestinationUrl: "https://drive.example",
      },
    });
  });

  it("loads protected storage state through Electron main without renderer credentials", async () => {
    let onFocus: (() => void) | undefined;
    const openExternal = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: (event: string, listener: () => void) => {
          if (event === "focus") onFocus = listener;
        },
        removeEventListener: vi.fn(),
        ipc: { openExternal, storage: { getStatus: state.getStatus } },
      },
    });
    const { StorageStatusProvider } = await import("./useStorageStatus.tsx");

    const provider = StorageStatusProvider({ children: ["home", "settings"] }) as {
      props: { value: { openSetup: (url: string) => void } };
    };
    expect(state.getStatus).toHaveBeenCalledOnce();

    onFocus?.();
    onFocus?.();
    expect(state.getStatus).toHaveBeenCalledOnce();

    provider.props.value.openSetup("https://app.plakk.io/account/setup");
    expect(openExternal).toHaveBeenCalledWith("https://app.plakk.io/account/setup");
    onFocus?.();
    onFocus?.();
    expect(openExternal).toHaveBeenCalledOnce();
  });
});
