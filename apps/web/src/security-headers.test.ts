import { describe, expect, it } from "vite-plus/test";

import { webSecurityHeaders } from "./security-headers.ts";

describe("Web response security headers", () => {
  it("restricts production documents and permits only the exact product API/provider seams", () => {
    const headers = webSecurityHeaders({
      apiOrigin: "https://api.plakk.io",
      production: true,
    });

    expect(headers).toMatchObject({
      "Cross-Origin-Opener-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).toContain("script-src-attr 'none'");
    expect(headers["Content-Security-Policy"]).toContain("https://api.plakk.io");
    expect(headers["Content-Security-Policy"]).not.toContain("*");
    expect(headers["Content-Security-Policy"]).not.toContain("http:");
  });

  it("omits HSTS locally while retaining the remaining browser protections", () => {
    const headers = webSecurityHeaders({
      apiOrigin: "http://localhost:3100",
      production: false,
    });

    expect(headers["Strict-Transport-Security"]).toBeUndefined();
    expect(headers["Content-Security-Policy"]).toContain("http://localhost:3100");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });
});
