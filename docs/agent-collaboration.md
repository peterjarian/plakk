# Agent Collaboration

This document exists because coding agents tend to make locally plausible fixes that miss the real system boundary. That is especially dangerous in core domains like auth, persistence, IPC, sync, billing, and security.

The goal is not more process. The goal is fewer bad edits.

## The Problem

Agents often optimize for the nearest visible complaint:

- remove the helper the user named
- add a schema where TypeScript asks for one
- create a small file to make imports look organized
- make checks pass
- explain the change as if that means the design is right

That is not enough. A local patch can still be wrong if it invents concepts, duplicates ownership, hides a bad model, or makes the system harder to reason about.

When a user gives examples, treat them as evidence of a broader rule. Do not treat them as the full task list.

## Required Behavior

For core-domain work, do not start by editing files. First identify ownership.

Answer these before coding:

- What concept is being changed?
- Which package or module already owns that concept?
- Does an existing type, schema, helper, config, or service already model it?
- What should be deleted instead of added?
- What files would be fake ownership if added?
- What checks or tests would catch the shortcut?

If the answer is unclear, inspect more code. Do not invent a local substitute.

## Ownership Rules

Use the existing owner before creating anything new.

- `apps/desktop` owns Electron lifecycle, native desktop integration, preload/main process wiring, and desktop runtime behavior.
- `packages/shared` owns product/domain shapes that cross process or package boundaries.
- `packages/ui` owns reusable UI surface code, not desktop-native behavior.
- IPC contracts own serialization between main, preload, and renderer.
- Effect services own effectful domain behavior and dependencies through layers.
- Environment variables are read with `Config` at the real use site or through a real config service. Do not create a config file just to hide one import.

A new file, helper, schema, or type needs a real owner. "This looks cleaner locally" is not a reason.

## Effect Rules

Follow Effect semantics, not just Effect syntax.

- Use `Effect.gen` for immediate effect bodies.
- Use `Effect.fn` for reusable functions.
- Do not invoke `Effect.fn` immediately as an IIFE.
- Keep failable work inside Effect in Effect-owned code.
- Do not catch and remap errors into a broader error when the original error is meaningful.
- Do not use raw `try/catch` in an Effect service unless the alternative is worse and the reason is obvious.
- Prefer existing `Schema` codecs at boundaries over ad hoc parsing.

## Anti-Patterns

Do not do these:

- invent a local schema when the shared/domain schema already exists
- invent a local user/auth/session shape to make a provider response fit
- map provider data into fake product data
- add placeholder values like `new Date(0)` to satisfy a type
- create one-line ownership files such as `authConfig.ts` unless there is a real grouped config owner
- add wrappers that only forward arguments to another function
- keep stale state and call it a cache unless it is actually a cache with defined invalidation
- make tests pass by duplicating production logic in the expectation

## Core-Domain Workflow

Use this workflow for auth, persistence, IPC, sync, billing, security, and other shared product behavior.

1. Read the existing flow end to end.
2. Write a short ownership audit.
3. Name the concepts that must not be invented.
4. Prefer deletion or moving responsibility to the owner.
5. Make the smallest coherent change at the owner boundary.
6. Run required checks.
7. Review the diff for fake ownership, duplicate concepts, and local-only cleanup.

For small UI or copy changes, this full workflow is unnecessary.

## Review Checklist

Before calling work done, verify:

- no new concept was created without an owner
- no existing concept was duplicated locally
- no file exists only to make imports look neat
- provider data is not coerced into product data with fake values
- Effect code follows Effect control flow
- errors remain honest and useful
- renderer state exposes only what the renderer uses
- persistence uses schema codecs at the boundary
- checks passed: `vp check` and `vp run typecheck`

Use `vp test` when behavior changed or when adding a guard against a shortcut.
