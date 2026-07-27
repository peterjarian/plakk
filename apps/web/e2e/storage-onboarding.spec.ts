import { expect, test } from "@playwright/test";

import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

const storageProof = (mode: string) => `${CONTROLLED_PRODUCT_ORIGIN}/?storage-onboarding=${mode}`;

test("first-run routing presents equal provider choices", async ({ page }) => {
  await page.goto(storageProof("first-run"));

  await expect(page.getByRole("heading", { name: "Link your storage" })).toBeVisible();
  const providerButtons = page.getByRole("button", {
    name: /^(Google Drive|OneDrive|Dropbox)$/,
  });
  await expect(providerButtons).toHaveCount(3);
  await expect(providerButtons.nth(0)).toHaveText("Google Drive");
  await expect(providerButtons.nth(1)).toHaveText("OneDrive");
  await expect(providerButtons.nth(2)).toHaveText("Dropbox");
  expect(new URL(page.url()).pathname).toBe("/storage");
});

test("provider choice starts WorkOS redirect without browser credentials", async ({ page }) => {
  const providerRequest = page.waitForRequest((request) =>
    request.url().includes("api.workos.com/data-integrations/google-drive/authorize-redirect"),
  );
  await page.route("https://api.workos.com/**", (route) => route.abort());
  await page.goto(storageProof("first-run"));
  await page.getByRole("button", { name: "Google Drive" }).click();

  const request = await providerRequest;
  const url = new URL(request.url());
  expect(url.searchParams.has("access_token")).toBe(false);
  expect(url.searchParams.has("client_secret")).toBe(false);
  expect(url.searchParams.has("provider_token")).toBe(false);
});

test("provider return confirms before rejecting false success", async ({ page }) => {
  await page.goto(storageProof("confirming"));

  await expect(page.getByText("Confirming your storage connection")).toBeVisible();
  await expect(page.getByText("Storage connection not confirmed")).toBeVisible();
  await expect(page.getByText("Nothing was changed", { exact: false })).toBeVisible();
  expect(new URL(page.url()).pathname).not.toBe("/snippets");
});

test("temporary failure is retryable without changing confirmed state", async ({ page }) => {
  await page.goto(storageProof("temporary-failure"));

  await expect(page.getByText("Storage setup is temporarily unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Google Drive" })).toBeVisible();
  expect(new URL(page.url()).pathname).not.toBe("/snippets");
});

test("authorization cancellation returns to a retryable state", async ({ page }) => {
  await page.goto(storageProof("authorization-failure"));

  await expect(page.getByText("Storage connection not confirmed")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Storage setup is temporarily unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Storage connection not confirmed")).toBeVisible();
});

test("authoritative Web success continues to Home", async ({ page }) => {
  await page.goto(storageProof("return-connected"));

  await expect(page.getByRole("heading", { name: "Your snippets" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/snippets");
});

test("Desktop-origin success offers both return and Web continuation", async ({ page }) => {
  await page.goto(storageProof("return-desktop"));

  await expect(page.getByText("return to Plakk Desktop", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue on Web" })).toBeVisible();
  expect(new URL(page.url()).pathname).not.toBe("/snippets");

  await page.getByRole("button", { name: "Continue on Web" }).click();
  await expect(page.getByRole("heading", { name: "Your snippets" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/snippets");
});
