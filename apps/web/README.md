# Plakk Web

TanStack Start host for the shared Plakk product UI and client runtime.

## Commands

```bash
pnpm --filter @plakk/web dev
pnpm --filter @plakk/web build
pnpm --filter @plakk/web test
pnpm --filter @plakk/web typecheck
```

## Environment

The canonical local-development inputs live in the repository root
[`/.env.example`](../../.env.example). Copy it to `.env.local` and start the complete stack with:

```bash
vp run dev
```

The development runner gives the web process its WorkOS credentials and derives
`WORKOS_REDIRECT_URI` and `VITE_PLAKK_RPC_URL` from the current device's Tailscale MagicDNS name.
Those generated values should not be stored in an environment file.

## Backend ownership

The web app owns the WorkOS browser authentication routes under `/api/auth/*`. It does not proxy
product RPC commands or live updates.

The browser connects directly to the independently deployed backend using `VITE_PLAKK_RPC_URL` for
commands and live snippet invalidations. Configure the matching browser origin as
`PLAKK_WEB_ORIGIN` in the backend.

## Desktop authentication handoff

Desktop sign-in uses `/auth/desktop/callback` as its WorkOS redirect URI. The route first commits a
browser completion page, then forwards the unchanged callback query to `plakk://auth/callback` in
production or `plakk-dev://auth/callback` during local development. The desktop app remains
responsible for PKCE validation and exchanging the authorization code.

During local development, `vp run dev` sets the desktop app's `WORKOS_REDIRECT_URI` to the Tailnet
web origin plus `/auth/desktop/callback`. In production it is
`https://app.plakk.io/auth/desktop/callback`. The exact URL must also be registered as an allowed
redirect URI for the WorkOS application.
