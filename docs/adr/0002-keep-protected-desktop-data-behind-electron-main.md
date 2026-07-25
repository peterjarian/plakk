---
status: accepted
---

# Keep protected desktop data behind Electron main

Electron main owns encrypted credentials, the desktop readable mirrors, synchronization, managed files, hydration, online commands, and state shared across windows. Renderer surfaces receive bounded readable projections and invoke product intentions through one controlled IPC seam; they do not receive bearer tokens, call protected backend procedures directly, persist a second product cache, or transport unrestricted file content through IPC. Electron main implements this ownership through focused deep modules for responsibilities such as projection, synchronization, uploads, managed content, downloads, commands, and session state rather than one giant interface or implementation. The modules remain behind the IPC seam so Home, Settings, and Tray do not orchestrate them.

Hooks adapt subscribed IPC state to React lifecycle. Renderer-local state owns interaction feedback such as input, selection, and dialogs; commands are not made into hooks merely for reuse. Electron main owns one persisted Device Snippet collection containing local-upload and published forms, and broadcasts that same collection to Home and Tray. Renderers infer presentation from those records rather than joining an upload-attempt collection to a separate Snippet cache or maintaining a renderer-local Zustand or Effect Atom registry.
