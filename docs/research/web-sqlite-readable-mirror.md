# SQLite-WASM constraints for the Web readable mirror

## Conclusion

`@effect/sql-sqlite-wasm@4.0.0-beta.99` is viable for an authenticated,
account-scoped readable mirror whose purpose is fast rendering. It should not
become a source of truth or a durability promise.

The planning consequences are:

- run the persistent client in a dedicated worker on HTTPS;
- regard the OPFS database as disposable and rebuild it from the backend after
  absence, eviction, corruption, or an unrecoverable startup/migration failure;
- decide the supported-browser floor and the behavior when OPFS is unavailable;
- decide one explicit multi-tab ownership model before implementation. The
  exact VFS cannot safely be opened independently by each tab.

## Decision-driving facts

### Persistence is useful but not guaranteed

The Effect OPFS worker opens the named SQLite database through
`AccessHandlePoolVFS`, which writes to the origin-private file system (OPFS).
The database therefore survives ordinary page reloads without retaining
Snippet content in application-managed files. The storage is scoped to the
site's origin, so preview, production, and any changed origin have separate
mirrors. [Effect OPFS worker, exact tag](https://github.com/Effect-TS/effect/blob/%40effect/sql-sqlite-wasm%404.0.0-beta.99/packages/sql/sqlite-wasm/src/OpfsWorker.ts#L43-L54)
[OPFS definition](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)

OPFS is quota-managed browser storage. Site-data clearing deletes it,
best-effort storage may be evicted, and private-browsing storage is normally
removed when that session ends. The browser may grant persistent storage, but
Plakk does not need to depend on that grant because the agreed Web contract has
no offline guarantee and the backend remains authoritative.
[Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

**Planning result:** loss of the mirror is a cache miss, not data loss. Recovery
must converge from the authenticated backend rather than require local repair
or backup.

### A dedicated worker and HTTPS are hard requirements

The VFS obtains OPFS files with `navigator.storage.getDirectory()` and opens
synchronous access handles. The web standard exposes
`createSyncAccessHandle()` only in secure contexts and dedicated workers.
[Exact VFS source](https://github.com/Effect-TS/wa-sqlite/blob/v0.1.2/src/examples/AccessHandlePoolVFS.js#L231-L270)
[File System standard](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createsyncaccesshandle)

The Effect client transport accepts a `Worker`, `SharedWorker`, or
`MessagePort`, and its OPFS module says it is intended for a dedicated or shared
worker. However, the provided OPFS worker itself invokes the dedicated-worker
API above. It is therefore not portable to assume that `OpfsWorker.run` can run
directly inside a `SharedWorker`; accepting that transport type does not remove
the platform restriction. This is an inference from the exact source and the
standard, not a claim made by Effect.
[Effect worker transport](https://github.com/Effect-TS/effect/blob/%40effect/sql-sqlite-wasm%404.0.0-beta.99/packages/sql/sqlite-wasm/src/SqliteClient.ts#L96-L105)
[Effect OPFS construction](https://github.com/Effect-TS/effect/blob/%40effect/sql-sqlite-wasm%404.0.0-beta.99/packages/sql/sqlite-wasm/src/OpfsWorker.ts#L43-L49)

**Planning result:** deploy Web on HTTPS and treat worker startup as part of the
application's required runtime, not an optional optimization.

### The exact VFS is single-instance, so tabs need ownership

`AccessHandlePoolVFS` documents that it is restricted to one `wa-sqlite`
instance and does not support multiple connections. It pre-opens exclusive
synchronous access handles for its OPFS files. The File System standard also
defines the default read-write sync handle as exclusive.
[VFS constraints, exact dependency tag](https://github.com/Effect-TS/wa-sqlite/blob/v0.1.2/src/examples/README.md#accesshandlepoolvfs)
[Access-handle pool source](https://github.com/Effect-TS/wa-sqlite/blob/v0.1.2/src/examples/AccessHandlePoolVFS.js#L231-L319)
[Exclusive-handle semantics](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createsyncaccesshandle)

The Effect client serializes statements only within one client using a
semaphore. It contains no cross-tab lock or leader protocol.
[Effect client serialization](https://github.com/Effect-TS/effect/blob/%40effect/sql-sqlite-wasm%404.0.0-beta.99/packages/sql/sqlite-wasm/src/SqliteClient.ts#L422-L431)

**Unresolved planning decision:** choose the observable multiple-tab contract
and a single owner for opening/migrating the OPFS database. Independently
opening the same mirror from every tab is outside the supported behavior of
this exact stack.

### Browser availability is broad; the support floor is still a product choice

OPFS synchronous access handles are broadly available in current desktop and
mobile engines (MDN's compatibility data lists Chrome/Edge 102, Firefox 111,
Safari/iOS Safari 15.2, Chrome Android 109, and Firefox Android 111 as their
initial supporting releases). They still require HTTPS and a dedicated worker.
[Compatibility and runtime requirements](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)

`SharedWorker` only became a Baseline feature in May 2026 and still has a
different compatibility history, so it cannot be used as a proxy for the OPFS
support floor.
[SharedWorker compatibility](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker)

**Unresolved planning decision:** state the minimum browser versions and choose
whether an unsupported browser receives a server-backed/in-memory experience or
an unsupported-browser message. This is chiefly relevant to the polished
mobile-web fallback.

### Startup, migrations, and failure recovery need bounded fallback

The worker sends `ready` only after WASM initialization, OPFS VFS creation, and
database open all succeed. The client waits for that message before becoming
usable. On a worker error the client tries to replace its scoped connection,
but the exact source does not settle outstanding requests or impose a startup
timeout.
[Worker readiness](https://github.com/Effect-TS/effect/blob/%40effect/sql-sqlite-wasm%404.0.0-beta.99/packages/sql/sqlite-wasm/src/OpfsWorker.ts#L43-L55)
[Client readiness and restart](https://github.com/Effect-TS/effect/blob/%40effect/sql-sqlite-wasm%404.0.0-beta.99/packages/sql/sqlite-wasm/src/SqliteClient.ts#L298-L351)

The package provides a migrator. The shared Effect migrator records numbered
migrations and executes pending migrations in a transaction, but the SQLite
adapter explicitly requires startup coordination when tabs/workers share a
database.
[SQLite-WASM migrator, exact tag](https://github.com/Effect-TS/effect/blob/%40effect/sql-sqlite-wasm%404.0.0-beta.99/packages/sql/sqlite-wasm/src/SqliteMigrator.ts#L1-L50)
[Transactional migrator](https://github.com/Effect-TS/effect/blob/%40effect/sql-sqlite-wasm%404.0.0-beta.99/packages/effect/src/unstable/sql/Migrator.ts#L219-L288)

**Planning result:** local-database readiness must not leave the product stuck
forever. Startup and migration failures need an explicit recoverable state, and
destructive rebuild is acceptable because the database is only a mirror.

## Confidence boundary

This is a beta package. Its exact-version package test is a no-op, and its OPFS
adapter imports `AccessHandlePoolVFS` from the dependency's `src/examples`
surface. Source inspection can establish the constraints above, but not real
browser interoperability.
[Exact package test](https://github.com/Effect-TS/effect/blob/%40effect/sql-sqlite-wasm%404.0.0-beta.99/packages/sql/sqlite-wasm/test/Client.test.ts)
[Exact package dependency and exports](https://github.com/Effect-TS/effect/blob/%40effect/sql-sqlite-wasm%404.0.0-beta.99/packages/sql/sqlite-wasm/package.json)

The execution plan should include a small compatibility proof on the chosen
desktop/mobile browser matrix before this stack becomes a release dependency;
that proof need not change Desktop-parity behavior or design a shared runtime.
