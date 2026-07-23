# Plakk Web

Blank TanStack Start app scaffolded with:

```bash
npx @tanstack/cli@latest create my-tanstack-app --agent --package-manager pnpm --tailwind
```

Follow-up Intent commands run after scaffolding:

```bash
npx @tanstack/intent@latest install
npx @tanstack/intent@latest list
```

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
```

## Backend ownership

The web app owns the WorkOS browser authentication routes under `/api/auth/*`. It does not proxy
product RPC commands or live updates.

Desktop connects directly to the independently deployed backend using `PLAKK_RPC_URL` for commands
and `PLAKK_SNIPPET_INVALIDATIONS_URL` for live Snippet invalidations.
