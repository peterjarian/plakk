import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "WORKOS_API_KEY=sk_test_browser_boundary WORKOS_CLIENT_ID=client_test_browser_boundary WORKOS_REDIRECT_URI=http://127.0.0.1:3000/api/auth/callback WORKOS_COOKIE_PASSWORD=browser-boundary-cookie-password-32-chars vp dev --host 127.0.0.1 --port 3000",
    port: 3000,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
