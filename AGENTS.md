## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Project Snapshot

Plakk is an early desktop-first app. Keep changes close to the current desktop loop; extract shared layers only when the duplication is real.

## Collaboration

Well functioning collaboration between the agent (you) and the developer (me) is really important for getting good results. Before starting always read `docs/agent-collaboration.md` which described expected behaviour.

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
