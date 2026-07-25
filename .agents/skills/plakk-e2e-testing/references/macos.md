# macOS playbook

Use this playbook only on the Mac that is running the Plakk Electron process. A remote shell may start or inspect the process, but UI control must attach to that Mac's logged-in desktop session.

## Preflight

From the repository root:

```sh
uname -s
git status --short --branch
git rev-parse --show-toplevel
git rev-parse HEAD
vp --version
ps -axo pid=,command= | rg 'Plakk|electron-vite|apps/desktop' || true
```

Confirm that required environment files or variable names exist without printing their values. Identify any already-running Plakk development app and the checkout that launched it. Multiple worktrees can produce apps with the same name and bundle identifier, so do not select a process by title alone.

## Start the local stack

Use separate long-lived terminal sessions for the backend and desktop:

```sh
vp run --filter @plakk/backend dev
```

```sh
plakk_profile="$(mktemp -d "${TMPDIR:-/tmp}/plakk-e2e-macos.XXXXXX")"
PLAKK_DESKTOP_USER_DATA_PATH="$plakk_profile" vp run --filter desktop dev
```

If the user supplied a profile or signed-in state, use that exact path instead of creating `plakk_profile`. Never copy, reset, or delete a supplied profile.

Wait for explicit backend readiness and Electron renderer readiness. Capture process output without exposing environment values. If launch fails, stop there and report the actual failure rather than opening a different installed Plakk build.

## Control the app

Read and follow the installed `computer-use:computer-use` skill for UI operations.

- Target the current checkout's actual Plakk development application or process. Prefer its absolute application path when duplicate app names or bundle identifiers are present.
- Read fresh app state before each action.
- Prefer accessibility roles, labels, text, and semantic element references.
- Use a screenshot to resolve missing accessibility information, but re-read state after any coordinate action.
- Keep attention on Plakk. Do not inspect unrelated applications, notifications, or private content.

Use Computer Use for surfaces that renderer automation cannot establish, including:

- tray and native menu behavior;
- close, hide, reopen, focus, and window lifecycle;
- native file or permission dialogs;
- clipboard and protocol handoff;
- visual integration defects that do not appear in semantic state.

When a repository-owned Electron automation harness exists, use it for deterministic renderer and main-process assertions first, then use Computer Use only for the native surfaces in scope. Do not add Playwright or another dependency merely to complete a validation-only task.

## Observe the promised effect

After each action:

1. Read fresh UI state.
2. Corroborate it with the relevant backend, persisted, provider, or Electron-owned state.
3. Perform the specified close, reopen, restart, or second-surface check.
4. Capture a narrowly scoped screenshot when the visible result matters.

Do not infer behavior from the presence of a button or the absence of an error dialog.

## Cleanup

Terminate only the backend and Electron processes started by this run. Remove only a temporary profile created by this run, and only after evidence no longer depends on it. Retain a failing profile when it is useful for diagnosis and report its exact path.
