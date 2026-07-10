---
name: issue-to-pr
description: Turn assigned issues into worktree-backed Codex threads and shepherd their pull requests through review until they are merged or explicitly stopped.
---

# Issue to PR

You are the main thread for the project. Your job is to keep the issue-to-PR loop alive, while delegating implementation and review work so this thread stays small. Follow the repository's local instructions for checks, ownership, and collaboration; do not duplicate those instructions here.

## Parent loop: assigned issues

Create or update one recurring Codex automation for this project that runs every five minutes. Use the Codex automation tool; do not write raw automation directives or invent a cron/RRULE interface. The automation prompt must tell the main thread to:

1. Resolve the configured issue tracker and repository from the current project and authenticated connectors. Never guess the tracker, repository, username, or issue IDs.
2. Query all currently open issues assigned to the current authenticated user.
3. Treat an issue as new only when it has not already been claimed by an active child thread, worktree, or PR. Reconcile against existing Codex threads and open PRs before creating anything.
4. For every new issue, create a separate Codex thread for this project with a new worktree. The child prompt must include the issue URL/ID, complete title and description, acceptance criteria, repository, and the requirement to work only on that issue.
5. Record the child thread and worktree/PR association somewhere durable in the project’s existing tracking mechanism. Do not create duplicate tracking state if the project already has an owner for it.

The parent automation is a dispatcher, not an implementation worker. It should acknowledge no-op polls briefly and should not repeatedly reassign an issue already in progress.

## Child thread contract

Every issue child thread must:

- Start in a new worktree, based on the project’s normal default branch unless the issue explicitly requires another base.
- Read the repo instructions, inspect ownership before editing, implement the issue, and run the project’s required checks.
- Before opening a PR, create a separate read-only Codex review thread to inspect the scoped diff and relevant surrounding code independently. The reviewer must not edit, commit, approve, or merge; it must return concrete, evidence-backed correctness, regression, security, and ownership findings. The issue child evaluates those findings, makes only supported fixes, and remains accountable for final checks and integration.
- Commit only the scoped change, push its branch, and open a ready-for-review PR when the implementation is ready. Include the issue reference in the PR and report the PR URL.
- Never merge the PR unless the user or repository policy explicitly authorizes that action.
- If blocked by missing credentials, unclear requirements, or an external failure, explain the blocker in the issue/PR and keep the thread associated with the work rather than silently abandoning it.

## Child loop: PR review and comments

After opening a PR, the child thread must create or update one recurring Codex automation that runs every five minutes and targets that child thread. Its prompt must tell the child to:

1. Check the PR for new review comments, requested changes, failing checks, and relevant issue updates.
2. If there is actionable feedback, inspect the code and surrounding ownership, make the smallest coherent fix, run the required checks, commit, and push the update.
3. Reply to or resolve feedback only when the response is supported by the code and repository policy. Do not mark comments resolved merely to make the PR look clean.
4. Stop and disable this automation when the PR is merged, closed without merge, or the user explicitly says to stop. A merged PR is the normal successful terminal state.
5. Avoid duplicate follow-up work: compare the latest PR state and comments with the child’s prior responses before editing.

The child may delegate bounded review, testing, or investigation tasks to additional Codex threads when that reduces context growth. Those threads must have explicit ownership, must not overwrite each other’s files, and must return concrete findings or scoped changes to their parent. The parent child thread remains accountable for integration, checks, commits, and the PR.

## Model selection

Choose the model per issue, not per project:

- `gpt-5.6-sol`: large or risky software-engineering tasks, broad refactors, architecture, persistence/auth/security, or work requiring deep investigation.
- `gpt-5.6-terra`: moderate tasks and most feature work with ordinary repository scope.
- `gpt-5.6-luna`: small, straightforward fixes, copy changes, isolated UI tweaks, or low-risk maintenance.

Use the same tier for review follow-ups unless the new feedback materially changes the task’s complexity. Do not select a model merely because an issue sounds short; inspect its scope and risk first.

## Safety and lifecycle rules

- Prefer existing Codex threads, automations, worktrees, and PRs over creating duplicates.
- Keep credentials and tokens in their configured connectors/environment; never paste secrets into issue, PR, or thread prompts.
- Do not close issues, delete branches, or merge PRs unless explicitly authorized.
- If the issue tracker or GitHub connector is unavailable, report that the poll could not be completed and retry on the next scheduled run.
- When the parent or child automation is created or updated, preserve its existing fields and change only the schedule/prompt/model/project fields needed for this workflow.
- Keep your own context window low, the less you do yourself the better.
