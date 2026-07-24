---
name: plakk-e2e-testing
description: Ensure Plakk behavior is exercised end to end in the real local Electron app on macOS or Linux. Use after implementing or reviewing user-visible, lifecycle, persistence, provider, tray, window, protocol, or other runtime behavior, and whenever the user asks for local end-to-end testing or runtime validation.
---

# Plakk end-to-end testing

Use this skill to perform the end-to-end part of a Plakk task. It is a testing discipline, not a certification gate: an honest observation, discrepancy, or blocked result is useful. Do not turn an unobserved path into a “pass.”

End to end means exercising the real local Electron application with its real local services, configuration, and OS integration. Unit tests, type checks, renderer-only browser tests, successful clicks, and screenshots are supporting evidence; none of them alone establish the runtime behavior.

## Start with the contract

1. Read the repository `AGENTS.md`, `docs/agent-collaboration.md`, the originating issue or specification, and any relevant protocol under `docs/validation/`.
2. Inspect the checkout, branch, worktree status, host platform, available environment files, and running Plakk processes. Never assume the visible app belongs to the current checkout.
3. Run `uname -s` and read exactly one platform playbook:
   - Darwin: [references/macos.md](references/macos.md)
   - Linux: [references/linux.md](references/linux.md)
   - Any other result: stop and report that this skill has no platform procedure for that host.
4. Write down the smallest scenario that reaches across the layers changed by the task:
   - starting state;
   - user action;
   - immediate visible behavior;
   - downstream or durable behavior;
   - reopen, restart, reconnect, or second-surface behavior when the feature promises it.

The feature specification defines expected behavior. This skill defines how to observe it.

## Prepare a real local run

- Treat authentication and environment configuration as prerequisites, not as the subject of the test unless the task itself concerns them.
- Confirm required environment variable names and files without printing values.
- Use the profile or signed-in state explicitly supplied by the user when the scenario needs it.
- Otherwise isolate the run with `PLAKK_DESKTOP_USER_DATA_PATH` so credentials, local state, managed files, and single-instance ownership do not collide with another Plakk process.
- Do not silently delete, reset, migrate, or reuse a developer profile.
- Start the real local backend and the real Electron app. Do not substitute a web preview for the desktop app.
- Record the exact checkout, commands, profile path, and process that produced the observed UI.

## Choose the strongest available control layer

Use the highest layer that can exercise the required behavior:

1. A repository-owned deterministic Electron E2E harness, when one exists.
2. Semantic UI control through the platform accessibility tree.
3. Fresh screenshots plus carefully bounded coordinate actions when semantic control cannot reach a required surface.
4. Direct inspection of backend, filesystem, provider, or Electron-owned state to corroborate what the UI shows.

Do not install a new automation framework during a validation-only task. If the repository lacks a deterministic harness, use the platform playbook and record that boundary. Native OS surfaces such as the tray, menus, dialogs, protocol handling, window close/hide behavior, and clipboard integration still require platform-level observation even when renderer automation exists.

Before every semantic action, read fresh UI state. Prefer stable roles, labels, and text over coordinates or stale element indices. After the action, read state again and verify the promised effect; “the click succeeded” is not an assertion.

## Exercise the scenario

Cover only the behavior in scope, but cross every boundary it depends on. Common boundaries include:

| Behavior under test            | Evidence to collect                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| Renderer interaction           | Control exists, accepts the action, and shows the expected state                   |
| Electron main-process behavior | Window, tray, menu, protocol, clipboard, or filesystem effect is observable        |
| Backend/provider behavior      | Authoritative state or a safe log/state projection agrees with the UI              |
| Persistence/lifecycle behavior | The state remains correct after the specified close, reopen, restart, or reconnect |
| Multiple product surfaces      | Home, Tray, or another relevant surface converges on the same state                |

Reuse an existing validation protocol when it matches the task. For completed-snippet lifecycle work, begin with `docs/validation/completed-snippet-lifecycle.md` instead of inventing a second protocol.

## Report evidence, not confidence

Report:

- platform, desktop/session type, checkout, commit, and profile boundary;
- exact scenario and commands;
- what was observed at each layer;
- screenshots or accessibility evidence when useful;
- logs or authoritative-state evidence with secrets and protected content removed;
- discrepancies, intermittent behavior, and blockers;
- what was not exercised and why;
- which processes and temporary profiles were cleaned up or intentionally retained.

Classify each scenario as **observed as expected**, **discrepancy observed**, or **blocked before observation**. Reserve “passed” for a project-defined gate that was actually run.

Never include credentials, tokens, provider identifiers, private snippet content, or a dump of the user's environment. Redact sensitive values from command output and screenshots.

## Keep repository gates separate

Run the repository-required checks after runtime testing:

```sh
vp check
vp run typecheck
```

Use targeted tests while iterating, `vp test` for the built-in Vite+ test command, and `vp run test` only when the package script is specifically required. Report these checks separately; they support but never replace the end-to-end observation.

## Boundaries

- Testing does not authorize source changes. Diagnose and report unless the user also asked for a fix.
- Do not broaden the scenario to unrelated private data or applications.
- Do not describe a renderer-only browser run as Electron end to end.
- Do not describe an attached window frame or a successful coordinate click as tested behavior.
- Do not claim a platform was covered when the agent never attached to that platform's local desktop session.
