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

WorkOS browser authentication requires:

```bash
WORKOS_API_KEY=sk_...
WORKOS_CLIENT_ID=client_...
WORKOS_REDIRECT_URI=http://localhost:3000/api/auth/callback
WORKOS_COOKIE_PASSWORD=32+ chars
VITE_PLAKK_RPC_URL=http://localhost:3100/api/rpc
```

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

Set the desktop app's `WORKOS_REDIRECT_URI` to
`http://localhost:3000/auth/desktop/callback` locally and
`https://app.plakk.io/auth/desktop/callback` in production. The exact URL must also be registered as
an allowed redirect URI for the WorkOS application.
