# Linux playbook

Use this playbook on an Ubuntu host with a logged-in local GNOME desktop session. The Electron process and UI driver must attach to that same desktop session. Running commands over SSH is acceptable; treating an SSH shell, a browser preview, or a virtual display as the user's desktop session is not.

The current reliable compatibility route is Electron on Xwayland with GNOME accessibility enabled. Recheck it on every host because session state is volatile.

## Preflight

From the repository root:

```sh
uname -s
git status --short --branch
git rev-parse --show-toplevel
git rev-parse HEAD
vp --version
command -v open-computer-use
open-computer-use --version
.agents/skills/plakk-e2e-testing/scripts/run-linux-x11.sh \
  open-computer-use doctor
.agents/skills/plakk-e2e-testing/scripts/run-linux-x11.sh \
  gsettings get org.gnome.desktop.interface toolkit-accessibility
```

Confirm required environment files or variable names without printing values. Do not dump `systemctl --user show-environment`; it can contain unrelated session data. The supplied helper imports only the desktop variables needed for Xwayland:

```sh
.agents/skills/plakk-e2e-testing/scripts/run-linux-x11.sh env |
  rg '^(DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|XDG_SESSION_TYPE|DBUS_SESSION_BUS_ADDRESS)='
```

If there is no active GNOME session, `DISPLAY` or `XAUTHORITY` is unavailable, accessibility is disabled, or Open Computer Use cannot attach, report the missing prerequisite. Do not silently enable a persistent desktop-wide setting or fall back to blind coordinates.

## Start the local stack

Use a long-lived terminal session for the backend:

```sh
vp run --filter @plakk/backend dev
```

Build the actual renderer and main process before launching Electron:

```sh
vp run --filter desktop build
```

Then launch the built app through the local Xwayland session:

```sh
plakk_profile="$(mktemp -d "${TMPDIR:-/tmp}/plakk-e2e-linux.XXXXXX")"
cd apps/desktop
PLAKK_DESKTOP_USER_DATA_PATH="$plakk_profile" \
  ../../.agents/skills/plakk-e2e-testing/scripts/run-linux-x11.sh \
  ./node_modules/.bin/electron \
  --no-sandbox \
  --ozone-platform=x11 \
  --force-renderer-accessibility \
  --password-store=gnome-libsecret \
  .
```

If the user supplied a profile or signed-in state, use that exact path instead of creating `plakk_profile`. Never copy, reset, or delete a supplied profile.

`--force-renderer-accessibility` is required for semantic renderer state. `--password-store=gnome-libsecret` prevents a session launched from SSH from silently degrading credential storage to basic text. If Plakk reports unavailable secure storage or Electron still selects `basic_text`, treat credential-dependent scenarios as blocked rather than accepting the degraded backend.

Wait for explicit backend and renderer readiness. If the renderer build is absent or launch fails, report that failure; do not attach Open Computer Use to another installed Electron app.

## Control the app

Prefer an installed Open Computer Use MCP tool when it is directly callable. The CLI is an acceptable fallback:

```sh
.agents/skills/plakk-e2e-testing/scripts/run-linux-x11.sh \
  open-computer-use call list_apps
.agents/skills/plakk-e2e-testing/scripts/run-linux-x11.sh \
  open-computer-use call get_app_state \
  --args '{"app":"electron","text_limit":"max","max_tree_nodes":3000,"max_tree_depth":96}'
```

Open Computer Use commonly exposes this development build under `electron`, even when the window title says Plakk. Resolve the app from `list_apps`; do not assume the title is the automation identifier.

- Read a fresh full accessibility tree before choosing an element.
- Prefer roles, labels, text, and semantic element indices.
- Re-read state after every action. Reuse an index only inside a single explicitly batched action sequence.
- Use screenshots and coordinates only for an in-scope surface that the accessibility tree cannot expose.
- Keep attention on Plakk and avoid unrelated desktop applications or private notifications.

If `get_app_state` returns only an outer frame:

1. Confirm the app is the Electron process launched from this checkout.
2. Confirm the renderer was built and loaded.
3. Recheck `toolkit-accessibility`.
4. Recheck that the process received `--force-renderer-accessibility`.
5. Recheck Xwayland `DISPLAY` and `XAUTHORITY`.
6. Retry with the automation identifier returned by `list_apps`.

Do not proceed with blind clicks while the renderer tree is missing.

When a repository-owned Electron automation harness exists, use it for deterministic renderer and main-process assertions first. Keep Open Computer Use for GNOME shell, tray, native menu, dialog, focus, and visual behaviors in scope.

## Observe the promised effect

After each action:

1. Read fresh application state.
2. Corroborate it with the relevant backend, persisted, provider, or Electron-owned state.
3. Perform the specified close, reopen, restart, reconnect, or second-surface check.
4. Capture narrowly scoped screenshots or accessibility excerpts.

An actionable accessibility tree proves control capability, not product correctness. The scenario still needs an assertion at the layer where the product promise lives.

## Cleanup

Terminate only backend, Electron, and Open Computer Use processes started by this run. Remove only a temporary profile created by this run, and only after evidence no longer depends on it. Retain a failing profile when it is useful for diagnosis and report its exact path.
