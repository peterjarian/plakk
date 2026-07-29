# Current Product Issues

This file tracks the issues identified while reviewing the current desktop and web
implementations. The groups are ordered by ownership rather than by the screen on
which a symptom appears.

## 1. Web uploads are broken

This is upload-path work, not UI polish.

### Problems

- Adding snippets on web never completes successfully.

### Scope

- Reproduce the failure through the existing web add controls.
- Trace the existing upload path from the browser source through provider transfer
  and Snippet publication.
- Fix the root cause without introducing a separate web upload architecture.

### Acceptance criteria

- The existing web add controls publish a Snippet successfully.
- The published Snippet synchronizes to another client.
- A failed upload reports an actionable product error.
