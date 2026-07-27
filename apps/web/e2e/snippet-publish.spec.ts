import { expect, test } from "@playwright/test";

import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

test("publishes page-scoped text and file work through the direct provider boundary", async ({
  page,
}) => {
  const providerRequests: Array<string> = [];
  await page.route("https://www.googleapis.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "PUT",
          "access-control-allow-origin": CONTROLLED_PRODUCT_ORIGIN,
        },
      });
      return;
    }
    providerRequests.push(request.url());
    if (url.searchParams.get("mode") === "pending") {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (url.searchParams.get("mode") === "failure") {
      await route.fulfill({
        status: 503,
        headers: { "access-control-allow-origin": CONTROLLED_PRODUCT_ORIGIN },
        body: "controlled provider failure",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": CONTROLLED_PRODUCT_ORIGIN },
      body: JSON.stringify({ id: `provider-${url.searchParams.get("upload_id")}` }),
    });
  });

  await page.goto(CONTROLLED_PRODUCT_ORIGIN);
  const composer = page.getByPlaceholder("Paste or write whatever you want");

  await composer.fill("authored text");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Text snippet").first()).toBeVisible();

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "selected-file.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("selected"),
  });
  await expect(page.getByText("selected-file.pdf")).toBeVisible();

  await page.getByRole("main", { name: "Plakk" }).dispatchEvent("drop", {
    dataTransfer: await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["dropped"], "dropped-file.txt", { type: "text/plain" }));
      return transfer;
    }),
  });
  await expect(page.getByText("Text snippet").nth(1)).toBeVisible();

  await page.getByRole("main", { name: "Plakk" }).evaluate((main) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "explicit pasted text");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    main.dispatchEvent(event);
  });
  await expect(page.getByText("Text snippet").nth(2)).toBeVisible();

  await fileInput.setInputFiles({
    name: "pending.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("pending"),
  });
  await expect(page.getByLabel("Syncing")).toBeVisible();
  await expect(page.getByLabel("Syncing")).toHaveCount(0);

  expect(providerRequests.length).toBeGreaterThanOrEqual(5);
  expect(providerRequests.every((url) => url.startsWith("https://www.googleapis.com/"))).toBe(true);
  await expect.poll(() => page.locator("html").getAttribute("data-publish-count")).toBe("5");
});

test("converges lost responses, exposes conflicts and failures, and enforces restrictions", async ({
  page,
}) => {
  await page.route("https://www.googleapis.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "PUT",
          "access-control-allow-origin": CONTROLLED_PRODUCT_ORIGIN,
        },
      });
      return;
    }
    if (url.searchParams.get("mode") === "failure") {
      await route.fulfill({
        status: 503,
        headers: { "access-control-allow-origin": CONTROLLED_PRODUCT_ORIGIN },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": CONTROLLED_PRODUCT_ORIGIN },
      body: JSON.stringify({ id: `provider-${url.searchParams.get("upload_id")}` }),
    });
  });

  await page.goto(CONTROLLED_PRODUCT_ORIGIN);
  const fileInput = page.locator('input[type="file"]');

  await fileInput.setInputFiles({
    name: "failure.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("failure"),
  });
  await expect(page.getByText("The upload provider rejected the file (503).")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss failed upload" }).click();
  await expect(page.getByText("failure.bin")).toHaveCount(0);

  await fileInput.setInputFiles({
    name: "conflict.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("conflict"),
  });
  await expect(
    page.getByText("Snippet identifier is already used by different content."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss failed upload" }).click();

  await fileInput.setInputFiles({
    name: "lost-response.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("lost"),
  });
  await expect(page.getByText("Controlled publication response was lost.")).toBeVisible();
  await page.getByRole("button", { name: "Refresh upload snapshot" }).click();
  await expect(page.getByText("lost-response.bin")).toBeVisible();
  await expect(page.getByText("Controlled publication response was lost.")).toHaveCount(0);

  await page.getByRole("button", { name: "Restrict billing" }).click();
  await expect(page.getByText("Billing access required.")).toBeVisible();
  await expect(page.getByPlaceholder("Paste or write whatever you want")).toHaveCount(0);
  const billingPrepareCount = await page.locator("html").getAttribute("data-prepare-count");
  await page.getByRole("main", { name: "Plakk" }).evaluate((main) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "blocked billing paste");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    main.dispatchEvent(event);
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-prepare-count",
    billingPrepareCount ?? "0",
  );

  await page.getByRole("button", { name: "Restore commands" }).click();
  await page.getByRole("button", { name: "Restrict storage" }).click();
  await expect(page.getByPlaceholder("Paste or write whatever you want")).toHaveCount(0);
  const storagePrepareCount = await page.locator("html").getAttribute("data-prepare-count");
  await page.getByRole("main", { name: "Plakk" }).evaluate((main) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "blocked storage paste");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    main.dispatchEvent(event);
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-prepare-count",
    storagePrepareCount ?? "0",
  );
});

test("reload interrupts page-lifetime work without resuming or publishing it", async ({ page }) => {
  let markProviderStarted: (() => void) | undefined;
  const providerStarted = new Promise<void>((resolve) => {
    markProviderStarted = resolve;
  });
  await page.route("https://www.googleapis.com/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "PUT",
          "access-control-allow-origin": CONTROLLED_PRODUCT_ORIGIN,
        },
      });
      return;
    }
    markProviderStarted?.();
    await new Promise<void>((resolve) => page.once("framenavigated", () => resolve()));
    await route.abort().catch(() => undefined);
  });

  await page.goto(CONTROLLED_PRODUCT_ORIGIN);
  await page.locator('input[type="file"]').setInputFiles({
    name: "interrupted-upload.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("interrupted"),
  });
  await expect(page.getByLabel("Syncing")).toBeVisible();
  await providerStarted;

  await page.reload();

  await expect(page.getByText("interrupted-upload.bin")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-publish-count", /.+/);
});
