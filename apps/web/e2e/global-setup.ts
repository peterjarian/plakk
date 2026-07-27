import { firefox } from "@playwright/test";

import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

export default async function globalSetup() {
  const browser = await firefox.launch();
  const page = await browser.newPage();

  try {
    await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?force-session-memory=true`);
    await page.getByRole("heading", { name: "Your snippets" }).waitFor();
  } finally {
    await browser.close();
  }
}
