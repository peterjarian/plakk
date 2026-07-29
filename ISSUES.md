# Current Product Issues

This file tracks the issues identified while reviewing the current desktop and web
implementations. The groups are ordered by ownership rather than by the screen on
which a symptom appears.

## 1. Web runtime reliability

This is runtime and platform-adapter work, not UI polish.

### Problems

- Adding snippets does not currently work reliably on web.
- A web runtime can report that Plakk is open in another browser tab even when the
  user cannot meaningfully recover from that state.
- Runtime startup failure is projected as several contradictory UI states:
  `Offline`, an inline internal error, and an unexplained `Try again` action.
- The browser-tab ownership and database-lock lifecycle are exposed directly to
  the user.

### Scope

- Reproduce web snippet uploads through text submission, paste, drag and drop, and
  file selection.
- Verify uploads with Google Drive, OneDrive, and Dropbox.
- Correct runtime and database-lock ownership across mount, unmount, refresh, and
  multiple browser tabs.
- Model startup, ready, waiting-for-another-tab, offline, and failed states
  explicitly instead of collapsing them into `error: string | null`.
- Give a real second tab a safe recovery path without signing the account out.

### Acceptance criteria

- All supported web add flows publish a Snippet and synchronize it to another
  client.
- A same-tab remount or development refresh does not produce a false tab-conflict
  state.
- A genuine second-tab state explains what is happening and recovers when runtime
  ownership becomes available.
- Runtime contention is not presented as an offline connection.
- One runtime failure produces one coherent user-facing state and recovery action.
