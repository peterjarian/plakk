// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DesktopApi } from "../../preload/index.ts";
import { Settings } from "./Settings.tsx";

const account = {
  id: "user_1",
  email: "reader@example.com",
  firstName: "Shortcut",
  lastName: "Tester",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

const ipc = vi.hoisted(() => ({
  beginRecording: vi.fn<DesktopApi["globalHotkey"]["beginRecording"]>(),
  cancelRecording: vi.fn<DesktopApi["globalHotkey"]["cancelRecording"]>(),
  get: vi.fn<DesktopApi["globalHotkey"]["get"]>(),
  update: vi.fn<DesktopApi["globalHotkey"]["update"]>(),
}));

vi.mock("../hooks/useAuth.ts", () => ({
  useAuth: () => ({ issue: null, isLoading: false, user: account }),
}));

vi.mock("../hooks/useLocalState.tsx", () => ({
  useLocalState: () => ({
    localState: { storageUsageBytes: 0 },
    isLoading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock("../hooks/useStorageStatus.tsx", () => ({
  openStorageSetup: vi.fn(),
  StorageProviderIcon: () => null,
  storageProviderLabel: () => "Storage",
  useLinkedStorageProvider: () => null,
  useStorageStatus: () => ({ kind: "offline" }),
}));

const initialStatus = {
  enabled: true,
  shortcut: "Mod+Shift+V",
  errorMessage: null,
} as const;

let savedStatus: {
  enabled: boolean;
  shortcut: string;
  errorMessage: string | null;
};
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  savedStatus = { ...initialStatus };
  ipc.beginRecording.mockReset().mockResolvedValue();
  ipc.cancelRecording.mockReset().mockImplementation(async () => savedStatus);
  ipc.get.mockReset().mockImplementation(async () => savedStatus);
  ipc.update.mockReset().mockImplementation(async (patch) => {
    savedStatus = { ...savedStatus, ...patch };
    return savedStatus;
  });
  Object.defineProperty(window, "ipc", {
    configurable: true,
    value: { globalHotkey: ipc } as unknown as DesktopApi,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Settings />);
    await Promise.resolve();
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Settings global hotkey recorder", () => {
  it("records a non-letter shortcut through TanStack and supports Escape cancellation", async () => {
    const recordButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Record global hotkey"]',
    );
    expect(recordButton).not.toBeNull();

    await act(async () => {
      recordButton?.click();
      await Promise.resolve();
    });
    expect(ipc.beginRecording).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Listening…");

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          ctrlKey: true,
          key: "ArrowUp",
          shiftKey: true,
        }),
      );
      await Promise.resolve();
    });
    expect(ipc.update).toHaveBeenLastCalledWith({ shortcut: "Mod+Shift+ArrowUp" });
    expect(container.textContent).toContain("Ctrl+Shift+↑");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Record global hotkey"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          ctrlKey: true,
          key: "+",
          shiftKey: true,
        }),
      );
      await Promise.resolve();
    });
    expect(ipc.update).toHaveBeenLastCalledWith({ shortcut: "Mod+Shift+=" });
    expect(container.textContent).toContain("Ctrl+Shift+=");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Record global hotkey"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await Promise.resolve();
    });

    expect(ipc.cancelRecording).toHaveBeenCalledOnce();
    expect(ipc.update).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Ctrl+Shift+=");
  });
});
