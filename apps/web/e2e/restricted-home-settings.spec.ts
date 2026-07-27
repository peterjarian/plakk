import { expect, test, type Page } from "@playwright/test";

import { WEB_SETTINGS_OMITTED_DESKTOP_CONTROLS } from "../src/product/web-settings-content-contract.ts";
import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

const expectRetainedRows = async (page: Page) => {
  await expect(page.locator("[data-snippet-row]")).toHaveCount(4);
  await expect(page.getByText("Text snippet", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Named download.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText("Retained photo.png", { exact: true })).toBeVisible();
};

const expectRestrictedProductActions = async (page: Page) => {
  await expect(page.getByPlaceholder("Paste or write whatever you want")).toHaveCount(0);
  const textRow = page.locator("[data-snippet-row]").first();
  await textRow.hover();
  await expect(textRow.getByRole("button", { name: "Copy" })).toBeDisabled();
  await expect(textRow.getByRole("button", { name: "Open link" })).toBeDisabled();
  await expect(textRow.getByRole("button", { name: "Delete" })).toBeEnabled();
  const fileRow = page.locator("[data-snippet-row]").nth(2);
  await fileRow.hover();
  await expect(fileRow.getByRole("button", { name: "Download" })).toBeDisabled();
  await expect(page.locator("html")).not.toHaveAttribute("data-copy-requested");
  await expect(page.locator("html")).not.toHaveAttribute("data-prepare-open-requested");
  await expect(page.locator("html")).not.toHaveAttribute("data-download-requested");
};

test("preserves normal Home hierarchy and Web-only Settings with persistent appearance", async ({
  page,
}) => {
  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?issue130=normal`);

  await expect(page.getByRole("heading", { name: "Your snippets" })).toBeVisible();
  await expect(page.getByText("Live updates connected")).toBeVisible();
  await expect(page.getByPlaceholder("Paste or write whatever you want")).toBeVisible();
  await expectRetainedRows(page);
  await page.locator("[data-snippet-row]").nth(0).hover();
  await expect(page.getByRole("button", { name: "Copy" }).first()).toBeEnabled();
  await page.getByText("Named download.pdf", { exact: true }).hover();
  await expect(page.getByRole("button", { name: "Download" }).first()).toBeEnabled();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByText("Restricted Reader")).toBeVisible();
  await expect(page.getByText("restricted@example.com")).toBeVisible();
  await expect(page.getByText("Trial active")).toBeVisible();
  await expect(page.getByText("August 10, 2026", { exact: false })).toBeVisible();
  await expect(page.getByText("Google Drive connected")).toBeVisible();
  await expect(page.getByRole("link", { name: "Email help" })).toHaveAttribute(
    "href",
    "mailto:help@plakk.io",
  );
  for (const desktopOnly of WEB_SETTINGS_OMITTED_DESKTOP_CONTROLS) {
    await expect(page.getByText(desktopOnly, { exact: false })).toHaveCount(0);
  }

  await page.getByRole("combobox", { name: "Appearance" }).click();
  await page.getByRole("option", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");

  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
});

test("billing-only restriction retains rows and recovers without a full-screen paywall", async ({
  page,
}) => {
  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?issue130=billing`);

  await expect(page.getByText("Billing access required", { exact: false })).toBeVisible();
  await expect(page.getByText("Storage access required", { exact: false })).toHaveCount(0);
  await expectRetainedRows(page);
  await expectRestrictedProductActions(page);
  await expect(page.getByRole("link", { name: "Help" })).toHaveAttribute(
    "href",
    "mailto:help@plakk.io",
  );

  await page.getByRole("button", { name: "Restore billing" }).click();
  await expect(page.getByText("Billing access required", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Paid access active", { exact: false })).toBeVisible();
  await expect(page.getByPlaceholder("Paste or write whatever you want")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-recovery-order", "billing");
});

test("storage-only restriction blocks provider actions but keeps Delete and recovery", async ({
  page,
}) => {
  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?issue130=storage`);

  await expect(page.getByText("Storage access required", { exact: false })).toBeVisible();
  await expect(page.getByText("Billing access required", { exact: false })).toHaveCount(0);
  await expectRetainedRows(page);
  await expectRestrictedProductActions(page);

  const retainedPhotoRow = page
    .locator("[data-snippet-row]")
    .filter({ hasText: "Retained photo.png" });
  await retainedPhotoRow.hover();
  await retainedPhotoRow.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Retained photo.png", { exact: true })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute(
    "data-delete-requested",
    "23d1e2f3-a456-4890-8abc-def012345678",
  );

  await page.getByRole("button", { name: "Reconnect storage" }).click();
  await expect(page.getByText("Storage access required", { exact: false })).toHaveCount(0);
  await expect(page.getByPlaceholder("Paste or write whatever you want")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-recovery-order", "storage");
});

test("simultaneous blockers recover billing first without falsely clearing storage", async ({
  page,
}) => {
  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?issue130=both`);

  await expect(page.getByText("Billing access required", { exact: false })).toBeVisible();
  await expect(page.getByText("Storage access required", { exact: false })).toBeVisible();
  await expect(
    page.getByText(
      "Restore billing and reconnect storage before Add, Copy, Download, and Open can resume",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Resolving billing will not clear this storage restriction", { exact: false }),
  ).toBeVisible();
  await expectRetainedRows(page);
  await expectRestrictedProductActions(page);

  await page.getByRole("button", { name: "Restore billing" }).click();
  await expect(page.getByText("Billing access required", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Storage access required", { exact: false })).toBeVisible();
  await expectRestrictedProductActions(page);
  await expect(page.locator("html")).toHaveAttribute("data-recovery-order", "billing");

  await page.getByRole("button", { name: "Reconnect storage" }).click();
  await expect(page.getByText("Storage access required", { exact: false })).toHaveCount(0);
  await expect(page.getByPlaceholder("Paste or write whatever you want")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-recovery-order", "billing,storage");
});

test("simultaneous blockers recover storage first while Settings and sign-out stay available", async ({
  page,
}) => {
  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?issue130=both`);

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByText("Billing access required", { exact: false })).toBeVisible();
  await expect(page.getByText("Google Drive needs reconnection")).toBeVisible();
  await expect(
    page.getByText("Storage recovery remains independent of billing recovery", { exact: false }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Reconnect storage" }).click();
  await expect(page.getByText("Google Drive connected")).toBeVisible();
  await expect(page.getByText("Billing access required", { exact: false })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-recovery-order", "storage");

  await page.getByRole("button", { name: "Restore billing" }).click();
  await expect(page.getByText("Paid access active", { exact: false })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-recovery-order", "storage,billing");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-sign-out-requested", "true");
});
