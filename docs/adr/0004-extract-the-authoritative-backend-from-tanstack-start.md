---
status: accepted
---

# Extract the authoritative backend from TanStack Start

Plakk extracts its authenticated product backend from the TanStack Start application into an independently runnable persistent backend. The extracted runtime owns the RPC interface, authoritative upload transitions, PostgreSQL change-feed wakes, and a guarded heartbeat-expiration sweep that runs on startup and periodically thereafter; PostgreSQL remains the source of truth, so process restarts or concurrent instances may delay work but cannot lose or duplicate an authoritative transition.

The current scope stops at the runtime seam, a production-style entry point, client configuration, and local tests. Deploying that runtime to Railway or another provider, provisioning Neon, introducing Alchemy or another infrastructure-as-code owner, and performing a production cutover are deferred to later work.
