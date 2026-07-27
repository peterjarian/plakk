import { expect, test } from "@playwright/test";

import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

const proofUrl = `${CONTROLLED_PRODUCT_ORIGIN}/?snippet-actions=true`;

const revealRow = async (page: import("@playwright/test").Page, index: number) => {
  const row = page.locator("[data-snippet-row]").nth(index);
  await row.hover();
  return row;
};

test.beforeEach(async ({ context, page }) => {
  await context
    .grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: CONTROLLED_PRODUCT_ORIGIN,
    })
    .catch(() => undefined);
  await page.goto(proofUrl);
  await expect(page.locator("[data-snippet-row]")).toHaveCount(8);
});

test("copies text through the real clipboard without retaining content between actions", async ({
  browserName,
  page,
}) => {
  const row = await revealRow(page, 0);
  await row.getByRole("button", { name: "Copy" }).click();
  await expect(row).toContainText("Copied");

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  if (browserName === "chromium") {
    expect(clipboardText).toBe("browser clipboard text");
  } else {
    expect(clipboardText === null || clipboardText === "browser clipboard text").toBe(true);
  }

  await row.getByRole("button", { name: "Copied" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-action-read-count", "2");
});

test("copies supported images and downloads the honest browser capability fallback", async ({
  browserName,
  page,
}) => {
  const row = await revealRow(page, 2);
  const downloadPromise = page.waitForEvent("download", { timeout: 2_000 }).catch(() => null);
  await row.getByRole("button", { name: "Copy" }).click();
  await expect(row).toContainText(/Copied|Image Copy is unavailable in this browser/);
  const copied = await row.getByRole("button", { name: "Copied" }).isVisible();
  const download = await downloadPromise;
  if (download !== null) {
    expect(download.suggestedFilename()).toBe("Copy image.png");
    await expect(row).toContainText("Image Copy is unavailable in this browser");
    return;
  }

  expect(copied).toBe(true);
  const clipboardTypes = await page
    .evaluate(async () => {
      const items = await navigator.clipboard.read();
      return items.flatMap((item) => item.types);
    })
    .catch(() => null);
  if (browserName === "chromium") expect(clipboardTypes).toContain("image/png");
});

test("downloads an image when the browser cannot decode it for clipboard conversion", async ({
  page,
}) => {
  const row = await revealRow(page, 6);
  const downloadPromise = page.waitForEvent("download");
  await row.getByRole("button", { name: "Copy" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("Undecodable image.png");
  await expect(row).toContainText("Image Copy is unavailable in this browser. Downloaded instead.");
});

test("downloads arbitrary files with their authoritative name", async ({ page }) => {
  const row = await revealRow(page, 3);
  const downloadPromise = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("Named download.pdf");
  await expect(row).toContainText("Downloaded");
});

test("streams oversized files from the trusted provider download target", async ({
  context,
  page,
}) => {
  await context.route("https://drive.usercontent.google.com/controlled-large-download", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "Content-Disposition": 'attachment; filename="Large archive.zip"',
        "Content-Type": "application/zip",
      },
      body: "controlled provider bytes",
    }),
  );
  const row = await revealRow(page, 7);
  const downloadPromise = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("Large archive.zip");
  await expect(row).toContainText("Downloaded");
});

test("opens only a fetched and explicitly confirmed hyperlink", async ({ context, page }) => {
  await context.route("https://example.com/**", (route) =>
    route.fulfill({ status: 200, body: "controlled external destination" }),
  );
  const row = await revealRow(page, 1);
  await row.getByRole("button", { name: "Open link" }).click();

  await expect(page.getByRole("dialog")).toContainText("Open external link?");
  await expect(page.getByRole("dialog")).toContainText("https://example.com/browser-proof");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("dialog").getByRole("button", { name: "Open link" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe("https://example.com/browser-proof");
});

test("does not misreport a noopener null result as a blocked external tab", async ({ page }) => {
  await page.evaluate(() => {
    window.open = () => null;
  });
  const row = await revealRow(page, 1);
  await row.getByRole("button", { name: "Open link" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Open link" }).click();
  await expect(row).not.toContainText("This link could not be opened.");
});

test("keeps the primary action visible on touch widths and Delete in overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(proofUrl);
  const row = page.locator("[data-snippet-row]").first();

  await expect(row.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(row.getByRole("button", { name: "More snippet actions" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Delete" })).toBeHidden();
  await row.getByRole("button", { name: "More snippet actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
});

test("keeps fetch and integrity failures row-local and retryable", async ({ page }) => {
  const retryRow = await revealRow(page, 4);
  await retryRow.getByRole("button", { name: "Copy" }).click();
  await expect(retryRow).toContainText("Plakk couldn’t fetch this snippet. Try again.");
  await retryRow.getByRole("button", { name: "Copy" }).click();
  await expect(retryRow).toContainText("Copied");

  const integrityRow = await revealRow(page, 5);
  await integrityRow.getByRole("button", { name: "Download" }).click();
  await expect(integrityRow).toContainText(
    "The downloaded content did not match this snippet. Try again.",
  );
});

test("gates content actions while Delete converges despite provider cleanup failure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_280, height: 1_000 });
  await page.getByRole("button", { name: "Restrict billing" }).click();
  await expect(page.getByText("Billing access required.")).toBeVisible();

  const row = await revealRow(page, 0);
  await expect(row.getByRole("button", { name: "Copy" })).toBeDisabled();
  await expect(row.getByRole("button", { name: "Delete" })).toBeEnabled();
  await row.getByRole("button", { name: "Delete" }).click();

  await expect(page.locator("[data-snippet-row]")).toHaveCount(7);
  await expect(page.locator("html")).toHaveAttribute(
    "data-provider-cleanup-failure",
    "observed-after-authority",
  );

  await page.getByRole("button", { name: "Restore commands" }).click();
  await page.getByRole("button", { name: "Restrict storage" }).click();
  const storageRestrictedRow = await revealRow(page, 0);
  await expect(storageRestrictedRow.getByRole("button", { name: "Copy" })).toBeDisabled();
  await expect(storageRestrictedRow.getByRole("button", { name: "Delete" })).toBeEnabled();
  await page.getByRole("button", { name: "Reconnect storage" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-storage-reconnect-requested", "true");
});
