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

WorkOS Pipes RPCs require:

```bash
WORKOS_API_KEY=sk_...
WORKOS_USER_ID=user_...
```

## RPC

The shared Effect RPC contract lives in `packages/shared/src/api/PlakkApi.ts`.
The web handler is `src/api/rpc.ts`, exposed through the TanStack server route at `src/routes/api/rpc.ts`.
