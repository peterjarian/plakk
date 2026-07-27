// @vitest-environment happy-dom

import type { AccountStatus, StorageProviderStatus } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  StorageOnboardingInitialization,
  StorageOnboardingView,
} from "./StorageOnboardingView.tsx";
import type { StorageOnboardingRead } from "./storage-onboarding-client.ts";

type StorageOnboardingViewProps = Parameters<typeof StorageOnboardingView>[0];

const account = (input: Partial<AccountStatus> = {}): AccountStatus => ({
  accessEntitlement: {
    status: "TRIAL_ACTIVE",
    trialEndsAt: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
  },
  blockedReasons: ["storage"],
  canSync: false,
  storageProvider: null,
  ...input,
});

const providerStatus = (status: StorageProviderStatus["status"]): StorageProviderStatus =>
  status === "CONNECTED"
    ? {
        storageProvider: "GOOGLE_DRIVE",
        status,
        externalDestinationUrl: "https://drive.example/folder",
      }
    : {
        storageProvider: "GOOGLE_DRIVE",
        status,
        externalDestinationUrl: null,
      };

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
});

const render = async (options: {
  readonly begin?: StorageOnboardingViewProps["begin"];
  readonly confirmationRequested?: boolean;
  readonly onContinueWeb?: StorageOnboardingViewProps["onContinueWeb"];
  readonly origin?: "WEB" | "DESKTOP";
  readonly providerHint?: "GOOGLE_DRIVE" | null;
  readonly read: () => Promise<StorageOnboardingRead>;
}) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  mountedRoots.push(root);
  const begin =
    options.begin ??
    vi
      .fn<StorageOnboardingViewProps["begin"]>()
      .mockResolvedValue({ url: "https://api.workos.com/provider-redirect" });
  const onContinueWeb =
    options.onContinueWeb ??
    vi.fn<StorageOnboardingViewProps["onContinueWeb"]>().mockResolvedValue(undefined);
  const onRedirect = vi.fn();

  await act(async () => {
    root.render(
      <StorageOnboardingView
        begin={begin}
        confirmationRequested={options.confirmationRequested ?? false}
        onContinueWeb={onContinueWeb}
        onRedirect={onRedirect}
        origin={options.origin ?? "WEB"}
        providerHint={options.providerHint ?? null}
        read={options.read}
      />,
    );
  });

  return { begin, container, onContinueWeb, onRedirect };
};

describe("storage onboarding view", () => {
  it("offers retry when account-product initialization fails", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const retry = vi.fn();
    mountedRoots.push(root);

    await act(async () => {
      root.render(<StorageOnboardingInitialization failed onRetry={retry} />);
    });
    expect(container.textContent).toContain("Storage setup could not start");

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    expect(retry).toHaveBeenCalledOnce();
  });

  it("presents Google Drive, OneDrive, and Dropbox as equal choices", async () => {
    const { container } = await render({
      read: () => Promise.resolve({ account: account(), providerStatus: null }),
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "Google Drive",
      "OneDrive",
      "Dropbox",
    ]);
    expect(new Set(buttons.map((button) => button.className))).toHaveLength(1);
  });

  it("prevents false success after callback until authoritative state confirms", async () => {
    const onContinueWeb = vi.fn().mockResolvedValue(undefined);
    const { container } = await render({
      confirmationRequested: true,
      onContinueWeb,
      providerHint: "GOOGLE_DRIVE",
      read: () =>
        Promise.resolve({
          account: account(),
          providerStatus: providerStatus("NOT_CONNECTED"),
        }),
    });

    expect(container.textContent).toContain("Storage connection not confirmed");
    expect(container.textContent).toContain("Nothing was changed");
    expect(onContinueWeb).not.toHaveBeenCalled();
  });

  it("rechecks authority instead of restarting OAuth while account capability catches up", async () => {
    const begin = vi.fn<StorageOnboardingViewProps["begin"]>();
    const read = vi.fn(() =>
      Promise.resolve({
        account: account({ storageProvider: "GOOGLE_DRIVE" }),
        providerStatus: providerStatus("CONNECTED"),
      }),
    );
    const { container } = await render({
      begin,
      confirmationRequested: true,
      providerHint: "GOOGLE_DRIVE",
      read,
    });

    expect(container.textContent).toContain("still being confirmed");
    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });

    expect(read).toHaveBeenCalledTimes(2);
    expect(begin).not.toHaveBeenCalled();
  });

  it("offers retry after authorization cancellation or failure", async () => {
    const begin = vi.fn().mockRejectedValue(new Error("provider cancelled"));
    const { container } = await render({
      begin,
      confirmationRequested: true,
      providerHint: "GOOGLE_DRIVE",
      read: () =>
        Promise.resolve({
          account: account(),
          providerStatus: providerStatus("NOT_CONNECTED"),
        }),
    });

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });

    expect(begin).toHaveBeenCalledWith("GOOGLE_DRIVE", "WEB");
    expect(container.textContent).toContain("temporarily unavailable");
    expect(container.textContent).toContain("Try again");
  });

  it("continues Web only after both authoritative reads agree", async () => {
    const onContinueWeb = vi.fn().mockResolvedValue(undefined);
    await render({
      confirmationRequested: true,
      onContinueWeb,
      providerHint: "GOOGLE_DRIVE",
      read: () =>
        Promise.resolve({
          account: account({
            blockedReasons: [],
            canSync: true,
            storageProvider: "GOOGLE_DRIVE",
          }),
          providerStatus: providerStatus("CONNECTED"),
        }),
    });

    expect(onContinueWeb).toHaveBeenCalledOnce();
  });

  it("keeps Desktop-origin success visible with an optional Web continuation", async () => {
    const { container, onContinueWeb } = await render({
      confirmationRequested: true,
      origin: "DESKTOP",
      providerHint: "GOOGLE_DRIVE",
      read: () =>
        Promise.resolve({
          account: account({
            blockedReasons: [],
            canSync: true,
            storageProvider: "GOOGLE_DRIVE",
          }),
          providerStatus: providerStatus("CONNECTED"),
        }),
    });

    expect(container.textContent).toContain("return to Plakk Desktop");
    expect(onContinueWeb).not.toHaveBeenCalled();

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    expect(onContinueWeb).toHaveBeenCalledOnce();
  });
});
