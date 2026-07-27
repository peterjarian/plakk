import { expect, test } from "@playwright/test";

test("Welcome enters the app-controlled WorkOS sign-in endpoint", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Move snippets between devices." })).toBeVisible();

  const requestPromise = page.waitForRequest((request) =>
    request.url().includes("/api/auth/sign-in"),
  );
  await page.route("**/api/auth/sign-in**", (route) => route.abort());
  await page.getByRole("link", { name: "Sign in" }).click();

  const request = await requestPromise;
  expect(new URL(request.url()).searchParams.get("returnPathname")).toBe("/snippets");
});

test("signed-out protected navigation preserves the requested route", async ({ page }) => {
  const requestPromise = page.waitForRequest((request) =>
    request.url().includes("/api/auth/sign-in"),
  );
  await page.route("**/api/auth/sign-in**", (route) => route.abort());
  await page.goto("/snippets").catch(() => undefined);

  const request = await requestPromise;
  expect(new URL(request.url()).searchParams.get("returnPathname")).toBe("/snippets");
});
