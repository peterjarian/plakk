# Current Product Issues

This file tracks the issues identified while reviewing the current desktop and web
implementations. The groups are ordered by ownership rather than by the screen on
which a symptom appears.

## 1. Web uploads are broken

This is upload-path work, not UI polish.

### Problems

- A snippet added on web appears locally as `Uploading` indefinitely.
- The upload never publishes, so the snippet does not appear on other clients.
- Refreshing the web app changes the abandoned local upload to `Upload interrupted`.

### Scope

- Trace the existing upload after its local record is created, through provider
  transfer and Snippet publication.
- Find why the background upload neither completes nor reaches a terminal failure
  before the page is refreshed.
- Fix the root cause without introducing a separate web upload architecture.

### Acceptance criteria

- The existing web add controls publish a Snippet successfully.
- The published Snippet synchronizes to another client.
- An upload never remains in `Uploading` indefinitely.
- A failed upload reports an actionable product error.
