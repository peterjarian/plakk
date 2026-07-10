import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  queries: [] as Array<{ tag: string; options: Record<string, unknown> }>,
  refreshes: [] as string[],
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
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: (atom: { tag: string }) => () => state.refreshes.push(atom.tag),
  useAtomValue: (atom: { tag: string }) =>
    atom.tag === "GetAccountStatus"
      ? {
          _tag: "Success",
          waiting: false,
          value: { canSync: true, storageProvider: "GOOGLE_DRIVE", blockedReasons: [] },
        }
      : {
          _tag: "Success",
          waiting: false,
          value: {
            storageProvider: "GOOGLE_DRIVE",
            status: "CONNECTED",
            externalDestinationUrl: "https://drive.example",
          },
        },
}));

vi.mock("@plakk/ui/atoms/rpc", () => ({
  createPlakkRpc: () => ({
    mutation: () => ({}),
    query: (tag: string, _payload: unknown, options: Record<string, unknown>) => {
      state.queries.push({ tag, options });
      return { tag };
    },
  }),
}));

vi.mock("./useAuth.ts", () => ({
  useAuth: () => ({ accessToken: "token", user: { id: "user_1" } }),
}));

describe("StorageStatusProvider", () => {
  beforeEach(() => {
    vi.resetModules();
    state.effects.length = 0;
    state.queries.length = 0;
    state.refreshes.length = 0;
  });

  it("shares stable queries and refreshes only after a setup flow returns", async () => {
    let onFocus: (() => void) | undefined;
    const openExternal = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: (event: string, listener: () => void) => {
          if (event === "focus") onFocus = listener;
        },
        removeEventListener: vi.fn(),
        ipc: { openExternal, runtimeConfig: { plakkRpcUrl: "https://rpc.example" } },
      },
    });
    const { StorageStatusProvider } = await import("./useStorageStatus.tsx");

    const provider = StorageStatusProvider({ children: ["home", "settings"] }) as {
      props: { value: { openSetup: (url: string) => void } };
    };
    expect(state.queries.map(({ tag }) => tag)).toEqual([
      "GetAccountStatus",
      "GetPipeConnectionStatus",
    ]);
    expect(state.queries.map(({ options }) => options.serializationKey)).toEqual([
      "account-status",
      "pipe-connection-GOOGLE_DRIVE",
    ]);

    onFocus?.();
    onFocus?.();
    expect(state.refreshes).toEqual([]);
    expect(state.queries).toHaveLength(2);

    provider.props.value.openSetup("https://app.plakk.io/account/setup");
    expect(openExternal).toHaveBeenCalledWith("https://app.plakk.io/account/setup");
    onFocus?.();
    onFocus?.();
    expect(state.refreshes).toEqual(["GetAccountStatus", "GetPipeConnectionStatus"]);
    expect(state.queries).toHaveLength(2);
  });
});
