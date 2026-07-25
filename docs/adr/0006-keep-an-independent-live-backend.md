---
status: accepted
---

# Keep an independent live backend

Plakk keeps the already-extracted backend as a small independently runnable live gateway. It owns authenticated commands, complete Snippet snapshots, provider upload preparation, Snippet publication and deletion, PostgreSQL `LISTEN`/`NOTIFY`, and a payload-free streaming RPC for invalidations. Publication and deletion notify the account only after their database transaction commits. Each authenticated stream filters those internal notifications and sends `SNIPPETS_CHANGED`; typed keep-alives preserve the connection without triggering a refresh. Reconnecting clients always refresh the complete snapshot, so notifications need no durability, payload, ordering, or replay. The stream supplies live-connection presentation but is not treated as universal command reachability and does not cancel uploads.

Desktop clients connect directly to this backend through one RPC interface for commands and live
invalidations. TanStack Start owns browser authentication routes only and does not proxy the
backend interface.

The backend no longer owns authoritative upload transitions, heartbeat expiration, scheduled recovery, or a durable change feed. If operating the separate deployment later costs more than it saves, its reduced command and invalidation interface can be moved without changing the desktop model.
