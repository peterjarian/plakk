// @vitest-environment happy-dom

import type { StorageCleanupRunResult, StorageManagementState } from "@plakk/shared/PlakkApi";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { StorageManagementView } from "./StorageManagementView.tsx";

type Props = Parameters<typeof StorageManagementView>[0];

const connected = (overrides: Partial<StorageManagementState> = {}): StorageManagementState => ({
  affectedSnippetCount: 3,
  cleanup: null,
  connectionStatus: "CONNECTED",
  externalDestinationUrl: "https://drive.example/folder",
  storageProvider: "GOOGLE_DRIVE",
  ...overrides,
});

const roots: Array<ReturnType<typeof createRoot>> = [];
const setInputValue = (input: HTMLInputElement, value: string) => {
  // oxlint-disable-next-line typescript/unbound-method -- The native setter is intentionally rebound to the test input.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("HTMLInputElement.value setter is unavailable.");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

const render = async (options: {
  readonly beginCleanup?: Props["beginCleanup"];
  readonly onCompleted?: Props["onCompleted"];
  readonly read?: Props["read"];
  readonly reauthorize?: Props["reauthorize"];
  readonly retryCleanup?: Props["retryCleanup"];
}) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const beginCleanup =
    options.beginCleanup ??
    vi.fn<Props["beginCleanup"]>().mockResolvedValue({
      action: "UNLINK",
      outcome: "COMPLETED",
    });
  const onCompleted = options.onCompleted ?? vi.fn<Props["onCompleted"]>();
  const reauthorize =
    options.reauthorize ??
    vi.fn<Props["reauthorize"]>().mockResolvedValue({
      url: "https://workos.example/authorize",
    });
  const retryCleanup =
    options.retryCleanup ??
    vi.fn<Props["retryCleanup"]>().mockResolvedValue({
      action: "UNLINK",
      outcome: "COMPLETED",
    });
  const onRedirect = vi.fn();

  await act(async () => {
    root.render(
      <StorageManagementView
        beginCleanup={beginCleanup}
        onCompleted={onCompleted}
        onRedirect={onRedirect}
        read={options.read ?? (() => Promise.resolve(connected()))}
        reauthorize={reauthorize}
        retryCleanup={retryCleanup}
      />,
    );
  });

  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (button === undefined) throw new Error(`Button not found: ${label}`);
    await act(async () => {
      button.click();
    });
  };

  return {
    beginCleanup,
    click,
    container,
    onCompleted,
    onRedirect,
    reauthorize,
    retryCleanup,
  };
};

describe("storage management view", () => {
  it("reconstructs the connected provider and exact authoritative count", async () => {
    const { container } = await render({});

    expect(container.textContent).toContain("Google Drive connected");
    expect(container.textContent).toContain("3 Snippets");
    expect(container.textContent).toContain("Unlink");
    expect(container.textContent).toContain("Switch");
  });

  it.each(["Unlink", "Switch"] as const)(
    "names permanent loss and requires exact DELETE before %s",
    async (action) => {
      const beginCleanup = vi.fn<Props["beginCleanup"]>();
      const { click, container } = await render({ beginCleanup });

      await click(action);
      expect(container.textContent).toContain("Google Drive");
      expect(container.textContent).toContain("3 Snippets");
      expect(container.textContent).toContain("permanently");
      expect(container.textContent).toContain("no migration");

      const confirm = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes(action),
      ) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);

      const input = container.querySelector("input") as HTMLInputElement;
      await act(async () => {
        setInputValue(input, "delete");
      });
      expect(confirm.disabled).toBe(true);

      await act(async () => {
        setInputValue(input, "DELETE");
      });
      expect(confirm.disabled).toBe(false);
    },
  );

  it("makes Cancel side-effect free", async () => {
    const beginCleanup = vi.fn<Props["beginCleanup"]>();
    const { click, container } = await render({ beginCleanup });

    await click("Switch");
    await click("Cancel");

    expect(container.textContent).toContain("Google Drive connected");
    expect(beginCleanup).not.toHaveBeenCalled();
  });

  it("reauthorizes the same provider without destructive copy", async () => {
    const { click, container, onRedirect, reauthorize } = await render({
      read: () =>
        Promise.resolve(
          connected({
            connectionStatus: "NEEDS_REAUTHORIZATION",
            externalDestinationUrl: null,
          }),
        ),
    });

    expect(container.textContent).toContain("needs reconnection");
    expect(container.textContent).toContain("Snippets are preserved");
    expect(container.textContent).not.toContain("permanently deleted");
    await click("Reconnect");
    expect(reauthorize).toHaveBeenCalledWith("GOOGLE_DRIVE");
    expect(onRedirect).toHaveBeenCalledWith("https://workos.example/authorize");
  });

  it("reports remaining work and retries without false success", async () => {
    const partial: StorageCleanupRunResult = {
      outcome: "PARTIAL",
      progress: {
        action: "SWITCH",
        lastFailure: "Could not remove remaining Google Drive content. Retry cleanup.",
        remainingSnippetCount: 2,
        totalSnippetCount: 3,
      },
    };
    const onCompleted = vi.fn<Props["onCompleted"]>();
    const { click, container, retryCleanup } = await render({
      onCompleted,
      read: () => Promise.resolve(connected({ cleanup: partial.progress })),
    });

    expect(container.textContent).toContain("2 of 3 Snippets remain");
    expect(container.textContent).toContain("credential stays connected");
    expect(onCompleted).not.toHaveBeenCalled();
    await click("Retry");
    expect(retryCleanup).toHaveBeenCalledWith("GOOGLE_DRIVE");
  });

  it("offers same-provider reconnection when partial cleanup lost credential access", async () => {
    const { click, container, onRedirect, reauthorize } = await render({
      read: () =>
        Promise.resolve(
          connected({
            cleanup: {
              action: "UNLINK",
              lastFailure: "Reconnect storage before retrying cleanup.",
              remainingSnippetCount: 1,
              totalSnippetCount: 3,
            },
            connectionStatus: "NEEDS_REAUTHORIZATION",
            externalDestinationUrl: null,
          }),
        ),
    });

    expect(container.textContent).toContain("1 of 3 Snippets remain");
    await click("Reconnect Google Drive");
    expect(reauthorize).toHaveBeenCalledWith("GOOGLE_DRIVE");
    expect(onRedirect).toHaveBeenCalledWith("https://workos.example/authorize");
  });

  it("keeps a destructive failure visible after refreshing authoritative state", async () => {
    const beginCleanup = vi
      .fn<Props["beginCleanup"]>()
      .mockRejectedValue(new Error("controlled count conflict"));
    const { click, container } = await render({ beginCleanup });

    await click("Unlink");
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "DELETE");
    });
    await click("Unlink permanently");

    expect(container.textContent).toContain("Cleanup did not start");
    expect(container.textContent).toContain("3 Snippets");
  });
});
