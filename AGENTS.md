## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Project Snapshot

Plakk is an early desktop-first app. Keep changes close to the current desktop loop; extract shared layers only when the duplication is real.

## TanStack Start Web App

- The web app lives in `apps/web` and was scaffolded from the TanStack CLI in scratch space with: `npx @tanstack/cli@latest create my-tanstack-app --agent --package-manager pnpm --tailwind`.
- Follow-up TanStack Intent commands run after scaffolding: `npx @tanstack/intent@latest install` and `npx @tanstack/intent@latest list`.
- Stack: React, TanStack Start blank app, TanStack Router file routes, Tailwind CSS, pnpm. The CLI reported `--tailwind` is deprecated and ignored because Tailwind is always enabled.
- The generated demo route/components/devtools packages were removed to keep the app blank and avoid extra integrations. Keep the generated Start/Vite/Router/Tailwind structure unless there is a clear reason to change it.
- RPC contract ownership stays in `packages/shared/src/api/PlakkApi.ts`. The web API handler lives in `apps/web/src/api/rpc.ts`; the TanStack server route at `apps/web/src/routes/api/rpc.ts` delegates POST `/api/rpc` to that Effect web handler.
- Effect guidance used for the RPC handler: `vp run effect-solutions list`, `vp run effect-solutions show basics`, and `vp run effect-solutions show services-and-layers`; inspected `.repos/effect-smol/LLMS.md`, `.repos/effect-smol/ai-docs/src/51_http-server/10_basics.ts`, `.repos/effect-smol/packages/platform-node/test/RpcServer.test.ts`, `.repos/effect-smol/packages/platform-node/test/fixtures/rpc-schemas.ts`, and `.repos/t3code/scripts/mock-update-server.ts`.
- Environment variables: none are required for the blank web app or current RPC `Ping` handler.
- Deployment: build with `pnpm --filter @plakk/web build`; run with `pnpm --filter @plakk/web start` only after adding a production start script if the deployment target needs one.
- Known gotchas: TanStack Start code is isomorphic by default, so server-only work belongs in server functions, server routes, or Effect handlers. Do not put DB, filesystem, or secrets in route loaders.
- Next steps: add real RPC handlers behind the existing shared contract when product behavior exists; do not add placeholder API concepts.

## Collaboration

Well functioning collaboration between the agent (you) and the developer (me) is really important for getting good results. Before starting always read `docs/agent-collaboration.md` which described expected behaviour. Also don't stop at making the change the developer requests. When reviewing or fixing code, don't treat the current call site as proof that a concept should exist: if existing state already expresses the same fact, prefer deleting the extra read/type/helper over adding API surface to satisfy it. When done with a big feature always spin up a background agent that does a code review that makes sure you **have not made the mistake of optimizing for local correctness**. Code review and fix until nothing can be fixed anymore. Last but not least: treat dirty worktree as work-in-progress so you can override it, change it and delete it. Don't be scared to change those files.

## Package Roles

- `apps/desktop`: Electron desktop app. Owns native shell integration, preload/main process code, and desktop-specific runtime behavior.
- `packages/ui`: Shared product UI package. Keep it focused on reusable UI/product surface code, not native desktop ownership.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding agents.

- Prefer examples and patterns from vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Keep `.repos/` excluded from fmt, lint, typecheck, and test scans unless explicitly validating the vendored repo itself.
- When writing Effect code, run `vp run effect-solutions list`, read the relevant `vp run effect-solutions show <topic>` output, then inspect `.repos/effect-smol/LLMS.md` and `.repos/effect-smol/` for idiomatic usage.
- When comparing desktop/runtime patterns, inspect `.repos/t3code/` as a reference, but do not copy architecture wholesale.

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.
