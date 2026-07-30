import { describe, expect, it } from "vite-plus/test";

import {
  inspectServeRoute,
  parseTailscaleIdentity,
  resolveApplicationEnvironments,
  resolveDeveloperEnvironment,
  resolveDevelopmentTopology,
} from "./dev.ts";

const developerEnvironment = {
  DATABASE_URL: "postgres://localhost/plakk",
  WORKOS_API_KEY: "sk_test",
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_COOKIE_PASSWORD: "a-secure-cookie-password-over-32-chars",
} as const;

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
        WORKOS_REDIRECT_URI: "https://apollo.example.ts.net/auth/desktop/callback",
      },
    });
  });

  it("gives generated topology precedence over developer-owned values", () => {
    const topology = resolveDevelopmentTopology("apollo.example.ts.net");

    expect(resolveApplicationEnvironments(developerEnvironment, topology)).toEqual({
      web: {
        WORKOS_API_KEY: "sk_test",
        WORKOS_CLIENT_ID: "client_test",
        WORKOS_COOKIE_PASSWORD: "a-secure-cookie-password-over-32-chars",
        WORKOS_REDIRECT_URI: "https://apollo.example.ts.net/api/auth/callback",
        VITE_PLAKK_RPC_URL: "https://apollo.example.ts.net:3100/api/rpc",
      },
      backend: {
        DATABASE_URL: "postgres://localhost/plakk",
        WORKOS_API_KEY: "sk_test",
        WORKOS_CLIENT_ID: "client_test",
        PLAKK_BACKEND_HOST: "127.0.0.1",
        PLAKK_WEB_ORIGIN: "https://apollo.example.ts.net",
        PORT: "3100",
      },
      desktop: {
        WORKOS_CLIENT_ID: "client_test",
        PLAKK_RPC_URL: "https://apollo.example.ts.net:3100/api/rpc",
        WORKOS_REDIRECT_URI: "https://apollo.example.ts.net/auth/desktop/callback",
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

describe("developer environment", () => {
  it("uses shell, local, root, then legacy precedence", () => {
    expect(
      resolveDeveloperEnvironment([
        { WORKOS_API_KEY: "shell-key" },
        { WORKOS_API_KEY: "local-key", WORKOS_CLIENT_ID: "local-client" },
        {
          DATABASE_URL: "postgres://root/plakk",
          WORKOS_API_KEY: "root-key",
          WORKOS_CLIENT_ID: "root-client",
          WORKOS_COOKIE_PASSWORD: "root-cookie-password-with-32-characters",
        },
        {
          DATABASE_URL: "postgres://legacy/plakk",
          WORKOS_COOKIE_PASSWORD: "legacy-cookie-password-over-32-chars",
        },
      ]),
    ).toEqual({
      DATABASE_URL: "postgres://root/plakk",
      WORKOS_API_KEY: "shell-key",
      WORKOS_CLIENT_ID: "local-client",
      WORKOS_COOKIE_PASSWORD: "root-cookie-password-with-32-characters",
    });
  });

  it("reports every missing human-owned value", () => {
    expect(() => resolveDeveloperEnvironment([{ WORKOS_CLIENT_ID: "client_test" }])).toThrow(
      "DATABASE_URL, WORKOS_API_KEY, WORKOS_COOKIE_PASSWORD",
    );
  });

  it("rejects short cookie passwords", () => {
    expect(() =>
      resolveDeveloperEnvironment([
        {
          ...developerEnvironment,
          WORKOS_COOKIE_PASSWORD: "too-short",
        },
      ]),
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
