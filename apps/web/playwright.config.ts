import { defineConfig, devices } from "@playwright/test";

import { CONTROLLED_PRODUCT_PORT } from "./e2e/controlled-product/config.ts";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "vp dev --host 127.0.0.1 --port 3000",
      env: {
        WORKOS_API_KEY: "sk_test_browser_boundary",
        WORKOS_CLIENT_ID: "client_test_browser_boundary",
        WORKOS_REDIRECT_URI: "http://127.0.0.1:3000/api/auth/callback",
        WORKOS_COOKIE_PASSWORD: "browser-boundary-cookie-password-32-chars",
      },
      port: 3000,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `vp dev --config e2e/controlled-product/vite.config.ts --host 127.0.0.1 --port ${CONTROLLED_PRODUCT_PORT}`,
      port: CONTROLLED_PRODUCT_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
