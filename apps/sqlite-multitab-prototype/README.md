# Effect SQLite multi-tab prototype

This spike tests whether Plakk Web can keep the official
`@effect/sql-sqlite-wasm` client and ordinary Effect SQL repositories while two
browser tabs use one OPFS-backed SQLite mirror.

## Result

The approach is viable, but changing the VFS class alone is insufficient.
`OPFSCoopSyncVFS` turns some synchronous SQLite operations into a two-step
operation: SQLite first returns busy while an OPFS/Web-Lock handoff runs, then
the caller retries. The custom worker in this prototype preserves Effect's
worker protocol and adds that retry adapter.

The repository remains unaware of the browser VFS. It depends on
`SqlClient.SqlClient`, uses `SqliteMigrator`, and retries transient lock errors
as Effect failures. A `BroadcastChannel` invalidates reads in the other tab.

The automated Firefox scenario was run three times successfully. Each run:

1. opened the same new database from two tabs concurrently;
2. ran the migration exactly once under a named Web Lock;
3. raced eight atomic increments from each tab and observed `16` in both;
4. disposed the first tab's worker and wrote `17` from the second;
5. reopened the first worker and read the preserved value `17`.

The 16-write contention test takes roughly 17 seconds in headless Firefox
because cooperative access-handle handoffs are intentionally conservative.
That is acceptable evidence for Plakk's text-snippet mirror, where writes are
infrequent, but it is not evidence for a write-heavy browser database.

## Run

Start the prototype:

```sh
vp run --filter @plakk/sqlite-multitab-prototype dev
```

Start `geckodriver` on port 4444, then run:

```sh
vp run --filter @plakk/sqlite-multitab-prototype e2e
```

The test task is deliberately uncached because it exercises browser state.

## Boundary for Web v1

Keep the adapter private to Web's SQLite worker. Application repositories and
migrations should use generic Effect SQL interfaces. Serialize migration
startup with a named Web Lock, retry transient database-lock failures, and use
a browser broadcast only for cross-tab invalidation.

Before treating this as production support, repeat the same contract tests in
the Web v1 browser matrix and add recovery coverage for a tab killed during a
write. This prototype establishes feasibility; it does not make the vendored
example VFS a supported Effect API.
