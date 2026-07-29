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

## 2. Snippet presentation lifecycle

This is shared client/read-model work, not `SnippetRow` styling.

### Problems

- A receiving client briefly renders `Text snippet` before replacing it with the
  title inferred from the content.
- The fallback presentation becomes visible during ordinary preview loading.

### Scope

- Keep Snippet presentation client-derived from file name and content; do not turn
  the inferred title into authoritative Snippet metadata.
- Coordinate preview availability and list projection so an eligible text Snippet
  is not first rendered with a temporary fallback title.
- Preserve an honest fallback for content that genuinely cannot be read or decoded.

### Acceptance criteria

- A valid remote text Snippet first appears with its inferred title.
- A hyperlink first appears with its hyperlink presentation.
- `Text snippet` is not shown as an intermediate loading state.
- Unreadable or invalid content still has a stable fallback presentation.

## Recommended implementation order

1. Web runtime reliability and uploads.
2. Snippet presentation lifecycle.
