// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => {
  const account = {
    id: "user_1",
    email: "reader@example.com",
    firstName: "Offline",
    lastName: "Reader",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;
  return {
    account,
    freeUp: vi.fn(),
    localState: {
      revision: 7,
      account,
      provider: { known: true, value: "GOOGLE_DRIVE" as const },
      capability: { status: "OFFLINE" as const },
      liveConnection: null,
      storageUsageBytes: 2048,
      snippets: [],
    },
  };
});

vi.mock("../hooks/useAuth.ts", () => ({
  useAuth: () => ({ issue: null, isLoading: false, user: state.account }),
}));

vi.mock("../hooks/useLocalState.tsx", () => ({
  useLocalState: () => ({
    localState: state.localState,
    isLoading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock("../hooks/useStorageStatus.tsx", () => ({
  openStorageSetup: vi.fn(),
  storageProviderLabel: () => "Google Drive",
  StorageProviderIcon: () => null,
  useLinkedStorageProvider: () => "GOOGLE_DRIVE",
  useStorageStatus: () => ({ kind: "offline", canSync: false }),
}));

import { Settings } from "./Settings.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<Root> = [];

const deferred = <A,>() => {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const renderSettings = async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<Settings />));
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes("Free up space"),
  );
  if (button === undefined) throw new Error("Free up space button was not rendered.");
  return { button, container };
};

beforeEach(() => {
  state.freeUp.mockReset();
  Object.defineProperty(window, "ipc", {
    configurable: true,
    value: {
      openExternal: vi.fn(),
      storage: { freeUp: state.freeUp },
    },
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
});

describe("Desktop settings", () => {
  it("does not advertise the unavailable global hotkey feature", async () => {
    const { container } = await renderSettings();

    expect(container.textContent).not.toContain("Global hotkey");
    expect(container.querySelector('select[aria-label="Appearance"]')).not.toBeNull();
  });
});

describe("Device storage settings", () => {
  it("prevents concurrent actions and immediately shows reclaimed usage", async () => {
    const request = deferred<{
      reclaimedBytes: number;
      removedCopies: number;
      storageUsageBytes: number;
    }>();
    state.freeUp.mockReturnValue(request.promise);
    const { button, container } = await renderSettings();

    await act(async () => {
      button.click();
      button.click();
    });

    expect(state.freeUp).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Freeing…");

    await act(async () => {
      request.resolve({ reclaimedBytes: 1024, removedCopies: 1, storageUsageBytes: 1024 });
      await request.promise;
    });

    expect(button.disabled).toBe(false);
    expect(container.textContent).toContain("1.0 KB used by Plakk");
    expect(container.textContent).toContain("Reclaimed 1.0 KB on this device.");
  });

  it("explains when no older device copies can be removed", async () => {
    state.freeUp.mockResolvedValue({
      reclaimedBytes: 0,
      removedCopies: 0,
      storageUsageBytes: 2048,
    });
    const { button, container } = await renderSettings();

    await act(async () => button.click());

    expect(container.textContent).toContain("No older device copies are available to remove.");
  });

  it("confirms a zero-byte older copy was removed instead of reporting a no-op", async () => {
    state.freeUp.mockResolvedValue({
      reclaimedBytes: 0,
      removedCopies: 1,
      storageUsageBytes: 2048,
    });
    const { button, container } = await renderSettings();

    await act(async () => button.click());

    expect(container.textContent).toContain("Removed 1 older device copy from this device.");
    expect(container.textContent).not.toContain("No older device copies");
  });

  it("restores the control and leaves usage unchanged after a useful error", async () => {
    const request = deferred<{
      reclaimedBytes: number;
      removedCopies: number;
      storageUsageBytes: number;
    }>();
    state.freeUp.mockReturnValue(request.promise);
    const { button, container } = await renderSettings();

    await act(async () => button.click());
    await act(async () => {
      request.reject(new Error("Plakk couldn’t free device space. Try again."));
      await request.promise.catch(() => undefined);
    });

    expect(button.disabled).toBe(false);
    expect(container.textContent).toContain("2.0 KB used by Plakk");
    expect(container.textContent).toContain("Plakk couldn’t free device space. Try again.");
    expect(container.textContent).not.toContain("Reclaimed");
  });
});
