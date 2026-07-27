import { expect, test } from "@playwright/test";

import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

test("active trial and exact-expiry restriction stay visible and honest at Home", async ({
  page,
}) => {
  await page.goto(CONTROLLED_PRODUCT_ORIGIN);

  await expect(page.getByText("Trial active", { exact: false })).toBeVisible();
  await expect(page.getByText("August 10, 2026", { exact: false })).toBeVisible();
  await expect(page.getByText("Initial snapshot.png")).toBeVisible();
  await expect(page.getByText("Billing access required", { exact: false })).toHaveCount(0);

  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?trial-at-exact-expiry=true`);

  await expect(page.getByText("Billing access required", { exact: false })).toBeVisible();
  await expect(page.getByText("Your snippets are preserved", { exact: false })).toBeVisible();
  await expect(
    page.getByText("Add, Copy, Download, and Open remain unavailable", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Initial snapshot.png")).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Add|Copy|Download|Open)$/ })).toHaveCount(0);
});
