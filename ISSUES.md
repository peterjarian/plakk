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

## 3. Shared product UI parity

This is product UI synchronization work. Small elements with one identical
implementation may live in `@plakk/ui`; larger surfaces such as Settings remain
independently implementable in each app. Each app continues to own its runtime
actions and platform shell.

### Problems

- Web Settings is rendered as a replacement screen with a Back button instead of
  a dialog.
- Web renders synchronization as a check icon with `Synced`; desktop renders the
  status as a small round indicator.
- Storage-provider actions differ between platforms in icons, labels, arrows,
  sizing, and styling.
- Common Settings terminology and composition drift between platforms, such as
  `Theme` on web and `Appearance` on desktop.
- Independently implemented product surfaces have no parity check, allowing small
  differences to accumulate.

### Scope

- Treat the established desktop presentation as the reference for product UI that
  exists on both platforms.
- Share only small product elements whose implementation is genuinely identical,
  such as the synchronization indicator.
- Keep Settings app-owned while synchronizing its common terminology, controls,
  visual treatment, and ordering between implementations.
- Keep Electron navigation, native window chrome, browser routing, runtime state,
  external-link execution, file acquisition, and theme persistence app-owned.
- Keep desktop-only Settings sections desktop-only.

### Acceptance criteria

- Web Settings opens as an accessible dialog over Home and has no Back button.
- Desktop and web render the same synchronization indicator module.
- Common storage-provider actions use the same icon, label, layout, and states.
- Common Settings rows use the same terminology, descriptions, controls, and
  ordering.
- Desktop and web Settings remain separate implementations with room for
  platform-specific additions.
- No generic `platform` prop, universal host adapter, or shared full-page route is
  introduced merely to force reuse.

## 4. User-facing error experience

This is cross-cutting work: runtime owners classify failures, while shared UI owns
their consistent presentation.

### Problems

- Web errors are shown as raw red text without enough context or a useful next
  action.
- Internal implementation conditions can leak into product copy.
- The same failure can be repeated in several unrelated places.
- Error presentation differs between desktop and web.

### Scope

- Define meaningful failure states at the module that owns each operation.
- Map known failures to concise user-facing explanations and relevant recovery
  actions.
- Add shared notice and failure presentation where desktop and web have the same
  user intention.
- Keep action-local failures near the action and reserve blocking states for
  failures that actually block the product surface.

### Acceptance criteria

- Error copy says what could not be completed and what the user can do next.
- Raw provider, database, lock, RPC, and JavaScript error text is not shown
  directly.
- A single failure is not duplicated across banners, composer feedback, and empty
  states.
- Notices and errors are accessible without relying on color alone.
- Equivalent desktop and web failures use the same product presentation.

## Recommended implementation order

1. Web runtime reliability and uploads.
2. Snippet presentation lifecycle.
3. Shared product UI parity.
4. Apply the shared error experience while implementing each owning area.
