import { expect, test, type Locator, type Page } from "@playwright/test";

import { WEB_SETTINGS_OMITTED_DESKTOP_CONTROLS } from "../src/product/web-settings-content-contract.ts";
import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

const expectNoHorizontalOverflow = async (page: Page) => {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
};

const expectVisibleFocus = async (target: Locator) => {
  await target.focus();
  await expect(target).toBeFocused();
  expect(
    await target.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.boxShadow !== "none" || style.outlineStyle !== "none";
    }),
  ).toBe(true);
};

test.describe("desktop browser hierarchy and keyboard interaction", () => {
  test.use({ viewport: { width: 1_280, height: 900 } });

  test("keeps Welcome focused and the Home hierarchy pointer and keyboard accessible", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Move snippets between devices." }),
    ).toBeVisible();
    await expectVisibleFocus(page.getByRole("link", { name: "Sign in" }));
    await expectNoHorizontalOverflow(page);

    await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?issue130=normal&force-session-memory=true`);
    await expect(page.getByRole("heading", { name: "Your snippets" })).toBeVisible();
    await expect(
      page.getByText("Uploads continue only while this page remains open."),
    ).toBeVisible();
    const firstRow = page.locator("[data-snippet-row]").first();
    await expectVisibleFocus(firstRow);
    await firstRow.hover();
    await expect(firstRow.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(firstRow.getByRole("button", { name: "Delete" })).toBeVisible();
  });
});

test.describe("mobile browser presentation and touch interaction", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });

  test("keeps Welcome and onboarding single-column, labelled, and free of overflow", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Move snippets between devices." }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto(
      `${CONTROLLED_PRODUCT_ORIGIN}/?storage-onboarding=first-run&force-session-memory=true`,
    );
    const providers = page.getByRole("button", { name: /^(Google Drive|OneDrive|Dropbox)$/ });
    await expect(providers).toHaveCount(3);
    const providerBoxes = await providers.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top };
      }),
    );
    expect(providerBoxes[0]?.left).toBe(providerBoxes[1]?.left);
    expect(providerBoxes[1]?.left).toBe(providerBoxes[2]?.left);
    expect(providerBoxes[0]?.right).toBe(providerBoxes[1]?.right);
    expect(providerBoxes[0]!.top).toBeLessThan(providerBoxes[1]!.top);
    expect(providerBoxes[1]!.top).toBeLessThan(providerBoxes[2]!.top);
    await expectNoHorizontalOverflow(page);
    const providerRequest = page.waitForRequest((request) =>
      request.url().includes("api.workos.com/data-integrations/google-drive/authorize-redirect"),
    );
    await page.route("https://api.workos.com/**", (route) => route.abort());
    await providers.first().tap();
    await providerRequest;
  });

  test("keeps Home actions discoverable and Settings rows usable without hover", async ({
    page,
  }) => {
    await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?issue130=normal&force-session-memory=true`);
    const firstRow = page.locator("[data-snippet-row]").first();
    await expect(firstRow.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(firstRow.getByRole("button", { name: "More snippet actions" })).toBeVisible();
    await expect(firstRow.getByRole("button", { name: "Delete" })).toBeHidden();
    await firstRow.getByRole("button", { name: "More snippet actions" }).tap();
    await expect(page.getByRole("menuitem", { name: "Open link" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Open link" }).tap();
    await expect(page.getByRole("dialog", { name: "Open external link?" })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).tap();

    await page.getByRole("button", { name: "Account menu" }).tap();
    await page.getByRole("menuitem", { name: "Settings" }).tap();
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Appearance" })).toBeVisible();
    for (const desktopOnly of WEB_SETTINGS_OMITTED_DESKTOP_CONTROLS) {
      await expect(page.getByText(desktopOnly, { exact: false })).toHaveCount(0);
    }
    await expectNoHorizontalOverflow(page);
  });

  test("keeps storage management forms and destructive actions inside the mobile column", async ({
    page,
  }, testInfo) => {
    await page.goto(
      `${CONTROLLED_PRODUCT_ORIGIN}/?storage-management=connected&storage-session=mobile-${testInfo.project.name}&force-session-memory=true`,
    );
    await page.getByRole("button", { name: "Unlink", exact: true }).tap();
    const confirmation = page.getByRole("textbox", { name: "Type DELETE to continue" });
    await expect(confirmation).toBeVisible();
    await confirmation.fill("DELETE");
    await expect(page.getByRole("button", { name: "Unlink permanently" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("keeps forced local-storage fallback supported and honest", async ({ page }, testInfo) => {
    await page.goto(
      `${CONTROLLED_PRODUCT_ORIGIN}/?account=mobile-memory-${testInfo.project.name}&force-session-memory=true`,
    );
    await expect(page.getByText("Initial snapshot.png")).toBeVisible();
    await expect(
      page.getByText("Fast local reads are unavailable", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("online service normally", { exact: false })).toBeVisible();
    await expect(page.getByText("This browser can’t run Plakk")).toHaveCount(0);
  });
});

test.describe("coarse pointer at desktop width", () => {
  test.use({
    viewport: { width: 1_024, height: 768 },
    hasTouch: true,
  });

  test("uses touch discoverability rather than assuming desktop width can hover", async ({
    page,
  }) => {
    await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?issue130=normal&force-session-memory=true`);
    const firstRow = page.locator("[data-snippet-row]").first();

    await expect(firstRow.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(firstRow.getByRole("button", { name: "More snippet actions" })).toBeVisible();
    await expect(firstRow.getByRole("button", { name: "Delete" })).toBeHidden();
  });
});
