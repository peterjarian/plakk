import { expect, test } from "@playwright/test";

import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

test("shows the exact trial warning and starts only an account-bound checkout", async ({
  page,
}) => {
  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?billing=trial`);

  await expect(page.getByText("August 10, 2026", { exact: false })).toBeVisible();
  await expect(page.getByText("10:15 AM", { exact: false })).toBeVisible();
  await expect(page.getByText("Billing starts immediately", { exact: false })).toBeVisible();
  await expect(
    page.getByText("permanently ends any unused trial time", { exact: false }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Subscribe annually" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-billing-request",
    JSON.stringify({
      externalCustomerId: "workos-controlled-user",
      plan: "ANNUAL",
    }),
  );
  const request = (await page.locator("html").getAttribute("data-billing-request")) ?? "";
  expect(request).not.toContain("token");
  expect(request).not.toContain("secret");
  expect(request).not.toContain("credential");
  await expect(page.locator("html")).toHaveAttribute(
    "data-billing-destination",
    "https://sandbox.polar.sh/checkout/annual",
  );
});

test("keeps checkout return gated until backend-confirmed paid entitlement", async ({ page }) => {
  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?billing=returned`);

  await expect(page.getByText("Waiting for Polar confirmation", { exact: false })).toBeVisible();
  await expect(page.getByText("Subscription confirmed by Polar", { exact: false })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-billing-refresh-count", /[1-9]\d*/);

  await page.getByRole("button", { name: "Confirm paid benefit" }).click();
  await expect(page.getByText("Subscription confirmed by Polar", { exact: false })).toBeVisible();
  await expect(page.getByText("Paid access active", { exact: false })).toBeVisible();
});

test("routes grace recovery through the account-bound portal and preserves storage restriction", async ({
  page,
}) => {
  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?billing=grace&storage-restricted=true`);

  await expect(page.getByText("Payment needs attention", { exact: false })).toBeVisible();
  await expect(page.getByText("September 3, 2026", { exact: false })).toBeVisible();
  await expect(page.getByText("Storage remains separate", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Recover billing" }).click();

  await expect(page.locator("html")).toHaveAttribute(
    "data-portal-request",
    JSON.stringify({ externalCustomerId: "workos-controlled-user" }),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-billing-destination",
    "https://sandbox.polar.sh/customer-portal/session",
  );
});

test("keeps recovery, Settings, help, and sign-out reachable while restricted", async ({
  page,
}) => {
  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?billing=restricted&storage-restricted=true`);

  await expect(page.getByText("Billing access required", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recover billing" })).toBeVisible();
  await expect(page.getByText("Storage remains separate", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Help" })).toHaveAttribute(
    "href",
    "mailto:help@plakk.io",
  );

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-settings-requested", "true");

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-sign-out-requested", "true");
});
