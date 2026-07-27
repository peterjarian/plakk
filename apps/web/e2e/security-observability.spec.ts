import { expect, test } from "@playwright/test";

import { CONTROLLED_PRODUCT_ORIGIN } from "./controlled-product/config.ts";

test("serves restrictive browser headers and server-managed AuthKit cookies", async ({ page }) => {
  const pageResponse = await page.goto("/");
  expect(pageResponse).not.toBeNull();
  const headers = pageResponse!.headers();
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).not.toContain("*");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["permissions-policy"]).toContain("camera=()");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");

  const signIn = await page.request.get("/api/auth/sign-in?returnPathname=%2Fsnippets", {
    maxRedirects: 0,
  });
  expect(signIn.status()).toBe(307);
  const cookie = signIn.headers()["set-cookie"];
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).not.toContain("Domain=");
});

test("correlates a failed browser action without exporting protected material", async ({
  page,
}) => {
  let rpcTraceparent: string | undefined;
  let telemetryTraceparent: string | undefined;
  let telemetryBody = "";
  let telemetryAuthorization: string | undefined;
  await page.route(`${CONTROLLED_PRODUCT_ORIGIN}/controlled-rpc`, async (route) => {
    rpcTraceparent = route.request().headers()["traceparent"];
    await route.fulfill({
      body: "raw provider body: private filename.txt and signed-provider-url",
      status: 403,
    });
  });
  await page.route(`${CONTROLLED_PRODUCT_ORIGIN}/api/telemetry/v1/traces`, async (route) => {
    const request = route.request();
    telemetryAuthorization = request.headers()["authorization"];
    telemetryBody = request.postData() ?? "";
    telemetryTraceparent = JSON.parse(telemetryBody).span.traceId;
    await route.fulfill({ status: 204 });
  });

  await page.goto(`${CONTROLLED_PRODUCT_ORIGIN}/?issue132=true`);
  await page.getByRole("button", { name: "Run protected action" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "This action could not be completed. Try again.",
  );
  await expect.poll(() => telemetryBody).not.toBe("");

  expect(rpcTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(telemetryTraceparent).toBe(rpcTraceparent!.split("-")[1]);
  expect(telemetryAuthorization).toBe("Bearer controlled-browser-token");
  expect(telemetryBody).not.toContain("controlled-browser-token");
  expect(telemetryBody).not.toContain("private filename.txt");
  expect(telemetryBody).not.toContain("signed-provider-url");
  await expect(page.locator("body")).not.toContainText("private filename.txt");
});
