import { expect, test as setup } from "@playwright/test";

import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

setup("warm the controlled product before Firefox scenarios", async ({ page }) => {
  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?force-session-memory=true`);
  await expect(page.getByRole("heading", { name: "Your snippets" })).toBeVisible({
    timeout: 30_000,
  });
});
