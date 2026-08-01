# Plakk

Plakk is a desktop-first workspace for collecting and working with context. The monorepo contains
the Electron desktop app, web app, backend, shared packages, and deployment infrastructure.

## Local development

Plakk uses one command to start the local product stack:

```bash
pnpm install
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env
cp apps/desktop/.env.example apps/desktop/.env
cp packages/db/.env.example packages/db/.env
vp run dev
```

Fill in each app's `.env` before starting. The backend owns database, WorkOS server, Polar, and
Redis configuration. The web app owns its WorkOS session configuration. The desktop app owns its
WorkOS public client configuration. `WORKOS_COOKIE_PASSWORD` must contain at least 32 characters.

The runner validates those inputs, checks that Tailscale is connected, configures the required
Tailscale Serve routes, and starts the backend, web app, and Electron desktop app. Press `Ctrl+C`
once to stop the processes it started.

For a non-visual development session, use `vp run dev --headless`. It still starts the Electron
desktop main process and its local runtime, but it does not create the main window, toolbar widget,
application menu, or any other visual desktop surface.

### Prerequisites

- Node.js 22.12 or newer
- pnpm 11
- the Vite+ `vp` CLI
- a reachable PostgreSQL database
- a WorkOS application
- Tailscale connected with MagicDNS and HTTPS enabled for the tailnet

Register these WorkOS redirect paths for the development device's MagicDNS hostname:

```text
https://<device>.<tailnet>.ts.net/api/auth/callback
https://<device>.<tailnet>.ts.net/api/auth/desktop/callback
```

The first callback belongs to browser authentication. The second hands desktop authentication back
to the Electron app.

## Environment ownership

Each app owns its own development environment. The runner loads values for that app in this order:

1. the invoking shell
2. `apps/<app>/.env.local`
3. `apps/<app>/.env`

An app cannot borrow a missing value from another app's file. Database tooling separately reads
`packages/db/.env.local` and `packages/db/.env`.

App files contain only values a developer or external provider owns. `vp run dev` derives and
injects all machine-specific topology into the relevant process:

| File                | Human-owned configuration                         |
| ------------------- | ------------------------------------------------- |
| `apps/backend/.env` | database, WorkOS server, Polar, Redis             |
| `apps/web/.env`     | WorkOS server, public client, and cookie password |
| `apps/desktop/.env` | WorkOS public client and optional user-data path  |
| `packages/db/.env`  | database commands                                 |

`PORT`, `PLAKK_BACKEND_HOST`, `PLAKK_WEB_ORIGIN`, `VITE_PLAKK_RPC_URL`, `PLAKK_RPC_URL`, and
`WORKOS_REDIRECT_URI` remain owned by the dev runner.

Generated values do not belong in `.env.example`: they depend on the current device and are printed
as the development topology whenever the runner starts. The runner will reuse matching persistent
Tailscale Serve routes and refuse to overwrite a conflicting route.

The deployment tooling has a separate contract in [`infra/.env.example`](infra/.env.example)
because Railway, Neon, and Axiom credentials belong to infrastructure rather than local app
runtime.

## Commands

```bash
vp run dev        # start the complete local stack
vp test           # run tests
vp check          # format and lint
vp run typecheck  # typecheck every package

pnpm db:generate
pnpm db:migrate
pnpm db:push
pnpm db:studio
```

Database commands read `DATABASE_URL` from the shell, `packages/db/.env.local`, or
`packages/db/.env`, in that order.
