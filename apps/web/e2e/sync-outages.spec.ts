import { expect, test } from "@playwright/test";

test("complete snapshots, outages, and reconnection stay honest at the Web product seam", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001");

  await expect(page.getByText("Initial snapshot.png")).toBeVisible();
  await expect(page.getByText("Live updates connected")).toBeVisible();

  await page.getByRole("button", { name: "Replace snapshot" }).click();
  await expect(page.getByText("Replacement snapshot.png")).toBeVisible();
  await expect(page.getByText("Initial snapshot.png")).toHaveCount(0);

  await page.getByRole("button", { name: "API outage" }).click();
  await expect(page.getByText("API unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByText("Replacement snapshot.png")).toBeVisible();
  await expect(page.getByText("Nothing added yet")).toHaveCount(0);

  await page.getByRole("button", { name: "Restore API" }).click();
  await expect(page.getByText("Live updates connected")).toBeVisible();
  await expect(page.getByText("API unavailable.", { exact: false })).toHaveCount(0);

  await page.getByRole("button", { name: "Disconnect stream" }).click();
  await expect(page.getByText("Live updates reconnecting.", { exact: false })).toBeVisible();
  await expect(page.getByText("Replacement snapshot.png")).toBeVisible();

  await expect(page.getByText("Reconnected snapshot.png")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("Replacement snapshot.png")).toHaveCount(0);
  await expect(page.getByText("Live updates connected")).toBeVisible();
});
