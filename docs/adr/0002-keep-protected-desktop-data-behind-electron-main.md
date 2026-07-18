---
status: accepted
---

# Keep protected desktop data behind Electron main

Electron main owns encrypted credentials, the desktop readable mirrors, synchronization, managed files, hydration, online commands, and state shared across windows. Renderer surfaces receive bounded readable projections and invoke product intentions through one controlled IPC seam; they do not receive bearer tokens, call protected backend procedures directly, persist a second product cache, or transport unrestricted file content through IPC. Electron main implements this ownership through focused deep modules for responsibilities such as projection, synchronization, uploads, managed content, downloads, commands, and session state rather than one giant interface or implementation. The modules remain behind the IPC seam so Home, Settings, and Tray do not orchestrate them.

Hooks adapt subscribed IPC state to React lifecycle. Renderer-local state owns interaction feedback such as input, selection, dialogs, and a screen-local optimistic overlay for the online command that screen invoked; commands are not made into hooks merely for reuse. Optimistic overlays are neither broadcast nor persisted and roll back from the shared projection on command failure. Electron main owns and broadcasts confirmed device state, including persisted upload recovery and active upload activity that Home and Tray must display consistently, rather than relying on a renderer-local Zustand or Effect Atom registry.
