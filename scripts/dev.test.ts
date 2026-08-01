import { describe, expect, it, vi } from "vite-plus/test";

import {
  type ApplicationEnvironmentSources,
  inspectServeRoute,
  parseDevelopmentOptions,
  parseTailscaleIdentity,
  resolveApplicationEnvironments,
  resolveDesktopDevelopmentLaunch,
  resolveDevelopmentTopology,
  waitForReadinessOrSignal,
} from "./dev.ts";

const applicationEnvironmentSources = {
  backend: [
    {
      DATABASE_URL: "postgres://localhost/plakk",
      PLAKK_BACKEND_HOST: "wrong-host",
      PLAKK_WEB_ORIGIN: "https://wrong.example.com",
      POLAR_ACCESS_BENEFIT_ID: "benefit_test",
      POLAR_ACCESS_TOKEN: "polar_test",
      POLAR_ENVIRONMENT: "sandbox",
      POLAR_PRODUCT_IDS: "product_monthly,product_yearly",
      PORT: "9999",
      REDIS_URL: "redis://localhost:6379",
      WORKOS_API_KEY: "sk_backend",
      WORKOS_CLIENT_ID: "client_backend",
    },
  ],
  desktop: [
    {
      PLAKK_RPC_URL: "https://wrong.example.com/api/rpc",
      WORKOS_CLIENT_ID: "client_desktop",
      WORKOS_REDIRECT_URI: "https://wrong.example.com/desktop-callback",
    },
  ],
  web: [
    {
      VITE_PLAKK_RPC_URL: "https://wrong.example.com/api/rpc",
      WORKOS_API_KEY: "sk_web",
      WORKOS_CLIENT_ID: "client_web",
      WORKOS_COOKIE_PASSWORD: "a-secure-cookie-password-over-32-chars",
      WORKOS_REDIRECT_URI: "https://wrong.example.com/web-callback",
    },
  ],
} satisfies ApplicationEnvironmentSources;

describe("development options", () => {
  it("keeps the normal desktop launch visual", () => {
    const options = parseDevelopmentOptions([]);
    expect(options).toEqual({ headless: false });
    expect(
      resolveDesktopDevelopmentLaunch(
        options,
        { WORKOS_CLIENT_ID: "client_desktop" },
        "/repo/apps/desktop/.electron-runtime/headless-user-data",
      ),
    ).toEqual({
      args: ["scripts/with-electron-native.mjs", "node", "scripts/dev-electron.mjs"],
      environment: { WORKOS_CLIENT_ID: "client_desktop" },
    });
  });

  it("starts Electron headlessly and disables desktop visual surfaces", () => {
    const options = parseDevelopmentOptions(["--headless"]);
    expect(options).toEqual({ headless: true });
    expect(
      resolveDesktopDevelopmentLaunch(
        options,
        { WORKOS_CLIENT_ID: "client_desktop" },
        "/repo/apps/desktop/.electron-runtime/headless-user-data",
      ),
    ).toEqual({
      args: [
        "scripts/with-electron-native.mjs",
        "node",
        "scripts/dev-electron.mjs",
        "--",
        "--headless",
        "--disable-gpu",
      ],
      environment: {
        PLAKK_DESKTOP_USER_DATA_PATH: "/repo/apps/desktop/.electron-runtime/headless-user-data",
        PLAKK_HEADLESS: "1",
        WORKOS_CLIENT_ID: "client_desktop",
      },
    });
  });

  it("preserves an explicitly configured headless desktop profile", () => {
    expect(
      resolveDesktopDevelopmentLaunch(
        { headless: true },
        {
          PLAKK_DESKTOP_USER_DATA_PATH: "/developer/profile",
          WORKOS_CLIENT_ID: "client_desktop",
        },
        "/repo/apps/desktop/.electron-runtime/headless-user-data",
      ).environment,
    ).toEqual({
      PLAKK_DESKTOP_USER_DATA_PATH: "/developer/profile",
      PLAKK_HEADLESS: "1",
      WORKOS_CLIENT_ID: "client_desktop",
    });
  });

  it("rejects unknown runner options", () => {
    expect(() => parseDevelopmentOptions(["--desktop-only"])).toThrow(
      "Unsupported development option: --desktop-only.",
    );
  });
});

describe("development topology", () => {
  it("derives one stable Tailnet topology and per-app environments", () => {
    expect(resolveDevelopmentTopology("apollo.example.ts.net")).toEqual({
      webOrigin: "https://apollo.example.ts.net",
      backendOrigin: "https://apollo.example.ts.net:3100",
      rpcUrl: "https://apollo.example.ts.net:3100/api/rpc",
      webEnvironment: {
        WORKOS_REDIRECT_URI: "https://apollo.example.ts.net/api/auth/callback",
        VITE_PLAKK_RPC_URL: "https://apollo.example.ts.net:3100/api/rpc",
      },
      backendEnvironment: {
        PLAKK_BACKEND_HOST: "127.0.0.1",
        PLAKK_WEB_ORIGIN: "https://apollo.example.ts.net",
        PORT: "3100",
      },
      desktopEnvironment: {
        PLAKK_RPC_URL: "https://apollo.example.ts.net:3100/api/rpc",
        WORKOS_REDIRECT_URI: "https://apollo.example.ts.net/api/auth/desktop/callback",
      },
    });
  });

  it("gives generated topology precedence over developer-owned values", () => {
    const topology = resolveDevelopmentTopology("apollo.example.ts.net");

    expect(resolveApplicationEnvironments(applicationEnvironmentSources, topology)).toEqual({
      web: {
        WORKOS_API_KEY: "sk_web",
        WORKOS_CLIENT_ID: "client_web",
        WORKOS_COOKIE_PASSWORD: "a-secure-cookie-password-over-32-chars",
        WORKOS_REDIRECT_URI: "https://apollo.example.ts.net/api/auth/callback",
        VITE_PLAKK_RPC_URL: "https://apollo.example.ts.net:3100/api/rpc",
      },
      backend: {
        DATABASE_URL: "postgres://localhost/plakk",
        POLAR_ACCESS_BENEFIT_ID: "benefit_test",
        POLAR_ACCESS_TOKEN: "polar_test",
        POLAR_ENVIRONMENT: "sandbox",
        POLAR_PRODUCT_IDS: "product_monthly,product_yearly",
        REDIS_URL: "redis://localhost:6379",
        WORKOS_API_KEY: "sk_backend",
        WORKOS_CLIENT_ID: "client_backend",
        PLAKK_BACKEND_HOST: "127.0.0.1",
        PLAKK_WEB_ORIGIN: "https://apollo.example.ts.net",
        PORT: "3100",
      },
      desktop: {
        WORKOS_CLIENT_ID: "client_desktop",
        PLAKK_RPC_URL: "https://apollo.example.ts.net:3100/api/rpc",
        WORKOS_REDIRECT_URI: "https://apollo.example.ts.net/api/auth/desktop/callback",
      },
    });
  });

  it("reads an online MagicDNS identity and removes its trailing dot", () => {
    expect(
      parseTailscaleIdentity(
        JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "apollo.example.ts.net.", Online: true },
        }),
      ),
    ).toEqual({ dnsName: "apollo.example.ts.net" });
  });

  it("rejects disconnected Tailscale state", () => {
    expect(() =>
      parseTailscaleIdentity(
        JSON.stringify({
          BackendState: "Stopped",
          Self: { DNSName: "apollo.example.ts.net.", Online: false },
        }),
      ),
    ).toThrow("Tailscale is not connected");
  });
});

describe("application environments", () => {
  const topology = resolveDevelopmentTopology("apollo.example.ts.net");

  it("uses shell values before app-local values", () => {
    const resolved = resolveApplicationEnvironments(
      {
        ...applicationEnvironmentSources,
        web: [{ WORKOS_API_KEY: "shell-key" }, ...applicationEnvironmentSources.web],
      },
      topology,
    );
    expect(resolved.web.WORKOS_API_KEY).toBe("shell-key");
    expect(resolved.backend.WORKOS_API_KEY).toBe("sk_backend");
  });

  it("does not borrow missing values from another app", () => {
    expect(() =>
      resolveApplicationEnvironments(
        {
          ...applicationEnvironmentSources,
          desktop: [{ WORKOS_API_KEY: "not-a-desktop-client-id" }],
        },
        topology,
      ),
    ).toThrow("Missing apps/desktop environment variables: WORKOS_CLIENT_ID");
  });

  it("reports the owning app for missing values", () => {
    expect(() =>
      resolveApplicationEnvironments(
        { ...applicationEnvironmentSources, backend: [{ WORKOS_CLIENT_ID: "client_test" }] },
        topology,
      ),
    ).toThrow("Missing apps/backend environment variables: DATABASE_URL");
  });

  it("rejects short web cookie passwords", () => {
    expect(() =>
      resolveApplicationEnvironments(
        {
          ...applicationEnvironmentSources,
          web: [
            {
              ...applicationEnvironmentSources.web[0],
              WORKOS_COOKIE_PASSWORD: "too-short",
            },
          ],
        },
        topology,
      ),
    ).toThrow("at least 32 characters");
  });
});

describe("Tailscale Serve reconciliation", () => {
  const input = {
    dnsName: "apollo.example.ts.net",
    httpsPort: 3100,
    target: "http://127.0.0.1:3100",
  } as const;

  it("recognizes an existing matching route", () => {
    expect(
      inspectServeRoute(
        JSON.stringify({
          Web: {
            "apollo.example.ts.net:3100": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3100" } },
            },
          },
        }),
        input,
      ),
    ).toEqual({ type: "ready" });
  });

  it("reports a missing route without inventing configuration", () => {
    expect(inspectServeRoute("{}", input)).toEqual({ type: "missing" });
  });

  it("preserves the conflicting proxy in its result", () => {
    expect(
      inspectServeRoute(
        JSON.stringify({
          Web: {
            "apollo.example.ts.net:3100": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:4100" } },
            },
          },
        }),
        input,
      ),
    ).toEqual({ type: "conflict", proxy: "http://127.0.0.1:4100" });
  });
});

describe("readiness cancellation", () => {
  it("aborts outstanding probes when shutdown is requested", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(
        waitForReadinessOrSignal(
          [{ name: "Tailnet web", url: "https://unreachable.example.test" }],
          Promise.resolve("SIGINT"),
        ),
      ).resolves.toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
