import { expect, test, type Page } from "@playwright/test";

import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

const managementProof = (mode: "connected" | "partial" | "reauthorization", session: string) =>
  `${CONTROLLED_PRODUCT_ORIGIN}/?storage-management=${mode}&storage-session=${session}`;

const confirmCleanup = async (page: Page, action: "Switch" | "Unlink") => {
  await page.getByRole("button", { name: action, exact: true }).click();
  const destructive = page.getByRole("button", {
    name: `${action === "Switch" ? "Switch provider" : action} permanently`,
  });
  await expect(destructive).toBeDisabled();
  await page.getByRole("textbox", { name: "Type DELETE to continue" }).fill("delete");
  await expect(destructive).toBeDisabled();
  await page.getByRole("textbox", { name: "Type DELETE to continue" }).fill("DELETE");
  await expect(destructive).toBeEnabled();
  await destructive.click();
};

test("authoritative refresh reconstructs provider and exact count; Cancel is inert", async ({
  page,
}, testInfo) => {
  const url = managementProof("connected", `reconstruct-${testInfo.project.name}`);
  await page.goto(url);

  await expect(page.getByRole("heading", { name: "Google Drive connected" })).toBeVisible();
  await expect(page.getByText("3 Snippets would be permanently removed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Google Drive" })).toHaveCount(0);

  await page.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(page.getByText("This permanently deletes 3 Snippets")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Google Drive connected" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Google Drive connected" })).toBeVisible();
  await expect(page.getByText("3 Snippets would be permanently removed")).toBeVisible();
});

test("same-provider reauthorization preserves content and pauses provider actions", async ({
  page,
}, testInfo) => {
  await page.goto(managementProof("reauthorization", `reauth-${testInfo.project.name}`));

  await expect(
    page.getByRole("heading", { name: "Google Drive needs reconnection" }),
  ).toBeVisible();
  await expect(page.getByText("Snippets are preserved", { exact: false })).toBeVisible();
  await expect(page.getByText("this is not an unlink", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Provider-dependent action" })).toBeDisabled();
  await page.getByRole("button", { name: "Reconnect Google Drive" }).click();
  await expect(page.getByText("Reauthorization requested for GOOGLE_DRIVE")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Snippets are preserved", { exact: false })).toBeVisible();
});

for (const action of ["Unlink", "Switch"] as const) {
  test(`${action} requires exact confirmation and routes only after complete cleanup`, async ({
    page,
  }, testInfo) => {
    await page.goto(
      managementProof("connected", `${action.toLowerCase()}-${testInfo.project.name}`),
    );

    await confirmCleanup(page, action);
    await expect(
      page.getByRole("heading", {
        name: action === "Switch" ? "Choose replacement storage" : "Choose a storage provider",
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Google Drive" })).toBeVisible();
    await expect(page.getByRole("button", { name: "OneDrive" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dropbox" })).toBeVisible();
  });
}

test("partial cleanup retains connection, rejects late commands, and Retry completes", async ({
  page,
}, testInfo) => {
  await page.goto(managementProof("partial", `partial-${testInfo.project.name}`));

  await expect(page.getByText("2 of 3 Snippets remain")).toBeVisible();
  await expect(page.getByText("credential stays connected", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Provider-dependent action" })).toBeDisabled();
  await page.getByRole("button", { name: "Attempt late command" }).click();
  await expect(page.getByText("Late command rejected during cleanup")).toBeVisible();

  await page.reload();
  await expect(page.getByText("2 of 3 Snippets remain")).toBeVisible();
  await page.getByRole("button", { name: "Retry cleanup" }).click();
  await expect(page.getByText("1 of 3 Snippets remain")).toBeVisible();
  await page.reload();
  await expect(page.getByText("1 of 3 Snippets remain")).toBeVisible();
  await page.getByRole("button", { name: "Retry cleanup" }).click();
  await expect(page.getByRole("heading", { name: "Choose replacement storage" })).toBeVisible();
});

test("a second Web surface converges on authoritative unlink completion", async ({
  context,
  page,
}, testInfo) => {
  const url = managementProof("connected", `convergence-${testInfo.project.name}`);
  const secondPage = await context.newPage();
  await Promise.all([page.goto(url), secondPage.goto(url)]);
  await expect(page.getByRole("heading", { name: "Google Drive connected" })).toBeVisible();
  await expect(secondPage.getByRole("heading", { name: "Google Drive connected" })).toBeVisible();

  await confirmCleanup(page, "Unlink");

  await expect(page.getByRole("heading", { name: "Choose a storage provider" })).toBeVisible();
  await expect(
    secondPage.getByRole("heading", { name: "No storage provider is linked" }),
  ).toBeVisible();
  await expect(secondPage.getByText("Choose a provider to resume storing Snippets.")).toBeVisible();
});
