import { expect, test } from "@playwright/test";

import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

const controlledUrl = (
  accountId: string,
  options?: {
    readonly backendUnavailable?: boolean;
    readonly forceSessionMemory?: boolean;
    readonly holdBackendRefresh?: boolean;
  },
) => {
  const url = new URL(CONTROLLED_PRODUCT_ORIGIN);
  url.searchParams.set("account", accountId);
  if (options?.backendUnavailable === true) {
    url.searchParams.set("backend-unavailable", "true");
  }
  if (options?.forceSessionMemory === true) {
    url.searchParams.set("force-session-memory", "true");
  }
  if (options?.holdBackendRefresh === true) {
    url.searchParams.set("hold-backend-refresh", "true");
  }
  return url.href;
};

test("an account mirror converges across tabs, survives handoff, reopens, and purges", async ({
  context,
}) => {
  test.setTimeout(90_000);
  const accountId = `m-${test.info().project.name}-${Date.now()}`;
  const url = controlledUrl(accountId);
  const first = await context.newPage();
  const second = await context.newPage();

  await Promise.all([first.goto(url), second.goto(url)]);
  await Promise.all([
    expect(first.getByText("Initial snapshot.png")).toBeVisible({ timeout: 20_000 }),
    expect(second.getByText("Initial snapshot.png")).toBeVisible({ timeout: 20_000 }),
  ]);
  await expect(first.getByText("Fast local reads are unavailable")).toHaveCount(0);
  await expect(second.getByText("Fast local reads are unavailable")).toHaveCount(0);

  await first.getByRole("button", { name: "Start stale delayed refresh" }).click();
  await expect(first.locator("html")).toHaveAttribute("data-backend-read-started", "true");
  await second.getByRole("button", { name: "Replace snapshot", exact: true }).click();
  await expect(first.getByText("Replacement snapshot.png")).toBeVisible({ timeout: 25_000 });
  await expect(second.getByText("Replacement snapshot.png")).toBeVisible({ timeout: 25_000 });
  await expect(first.getByText("Stale snapshot.png")).toHaveCount(0);
  await expect(second.getByText("Stale snapshot.png")).toHaveCount(0);

  await first.getByRole("button", { name: "Start interruptible replacement" }).click();
  await expect(first.locator("html")).toHaveAttribute("data-mirror-write-started", "true");
  await first.close();

  await second.getByRole("button", { name: "Replace after close" }).click();
  await expect(second.getByText("After close.png")).toBeVisible({ timeout: 25_000 });

  const reopened = await context.newPage();
  await reopened.goto(controlledUrl(accountId, { holdBackendRefresh: true }));
  await expect(reopened.getByText("After close.png")).toBeVisible({ timeout: 20_000 });
  await expect(reopened.getByText("Fast local reads are unavailable")).toHaveCount(0);
  await reopened.close();

  const purging = await context.newPage();
  await purging.goto(controlledUrl(accountId, { backendUnavailable: true }));
  await expect(purging.getByText("After close.png")).toBeVisible({ timeout: 20_000 });
  await expect(purging.getByText("API unavailable")).toBeVisible();

  await second.getByRole("button", { name: "Start interruptible replacement" }).click();
  await expect(second.locator("html")).toHaveAttribute("data-mirror-write-started", "true");
  await purging.getByRole("button", { name: "Purge account facts" }).click();
  await expect(purging.getByText("After close.png")).toHaveCount(0, { timeout: 20_000 });
  await expect(second.getByText("After close.png")).toHaveCount(0, { timeout: 20_000 });
  await expect(second.getByText("Loading snippets")).toBeVisible();

  await second.close();
  await purging.close();
  const afterPurge = await context.newPage();
  await afterPurge.goto(controlledUrl(accountId, { holdBackendRefresh: true }));
  await expect(afterPurge.getByText("Loading snippets")).toBeVisible();
  await expect(afterPurge.getByText("After close.png")).toHaveCount(0);
});

test("capability failure uses session memory and presents the degraded notice", async ({
  page,
}) => {
  const accountId = `browser-memory-${test.info().project.name}-${Date.now()}`;
  await page.goto(controlledUrl(accountId, { forceSessionMemory: true }));

  await expect(page.getByText("Initial snapshot.png")).toBeVisible();
  await expect(page.getByText("Fast local reads are unavailable", { exact: false })).toBeVisible();
  await expect(page.getByText("online service normally", { exact: false })).toBeVisible();
});
