# Plakk

Plakk is a desktop-first workspace for collecting and working with context. The monorepo contains
the Electron desktop app, web app, backend, shared packages, and deployment infrastructure.

## Local development

Plakk uses one command to start the local product stack:

```bash
pnpm install
cp .env.example .env.local
vp run dev
```

Fill in the four required values in `.env.local` before starting:

- `DATABASE_URL`
- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `WORKOS_COOKIE_PASSWORD` (at least 32 characters)

The runner validates those inputs, checks that Tailscale is connected, configures the required
Tailscale Serve routes, and starts the backend, web app, and Electron desktop app. Press `Ctrl+C`
once to stop the processes it started.

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
https://<device>.<tailnet>.ts.net/auth/desktop/callback
```

The first callback belongs to browser authentication. The second hands desktop authentication back
to the Electron app.

## Environment ownership

Local development has one canonical input file at the repository root. The runner loads values in
this order:

1. the invoking shell
2. `.env.local`
3. `.env`
4. legacy app-local `.env` files, as a compatibility fallback

Use `.env.local` for normal development. Legacy app-local files are intentionally undocumented and
may be removed after existing workstations have migrated.

The root file contains only values a developer or external provider owns. `vp run dev` derives and
injects all machine-specific topology:

| Variable                       | Consumer                | Owner               |
| ------------------------------ | ----------------------- | ------------------- |
| `DATABASE_URL`                 | backend, database tools | developer           |
| `WORKOS_API_KEY`               | backend, web            | WorkOS/developer    |
| `WORKOS_CLIENT_ID`             | backend, web, desktop   | WorkOS/developer    |
| `WORKOS_COOKIE_PASSWORD`       | web                     | developer           |
| `PLAKK_DESKTOP_USER_DATA_PATH` | desktop                 | developer, optional |
| `PORT`, `PLAKK_BACKEND_HOST`   | backend                 | dev runner          |
| `PLAKK_WEB_ORIGIN`             | backend                 | dev runner          |
| `VITE_PLAKK_RPC_URL`           | web                     | dev runner          |
| `PLAKK_RPC_URL`                | desktop                 | dev runner          |
| `WORKOS_REDIRECT_URI`          | web, desktop            | dev runner          |

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

Database commands read `DATABASE_URL` from the shell, root `.env.local`, or root `.env`, in that
order.
