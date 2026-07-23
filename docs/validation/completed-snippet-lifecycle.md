# Completed-Snippet lifecycle validation

This document is the reproducible validation protocol and evidence record for issue #80. It keeps
the permanent automated coverage at module boundaries while making the two-profile, real-provider
exercise repeatable without recording credentials, access tokens, provider object identifiers, or
snippet content.

## Two-profile setup

`PLAKK_DESKTOP_USER_DATA_PATH` overrides Electron's `userData` directory before any credentials,
Device Snippet records, Local State, managed content, or single-instance ownership are opened. Use
an absolute, disposable path for each profile.

Start the backend:

```sh
vp run --filter @plakk/backend dev
```

Prepare two empty profile roots:

```sh
mkdir -p /tmp/plakk-origin /tmp/plakk-replica
```

Start and sign in the origin profile before starting the replica profile. This ordering matters on
Linux because the development protocol handler is updated for the most recently launched profile.

```sh
PLAKK_DESKTOP_USER_DATA_PATH=/tmp/plakk-origin vp run --filter desktop dev
```

Then start and sign in the replica from another terminal:

```sh
PLAKK_DESKTOP_USER_DATA_PATH=/tmp/plakk-replica vp run --filter desktop dev
```

Both processes use the normal signed-in Electron application and the same configured backend while
their credentials, persisted Device Snippet collections, Local State, and managed files remain
independent. Use disposable paths that contain no other data and remove only those exact paths
after validation.

## Scenario protocol

Record pass, fail, or blocked for each scenario without including protected data.

1. Open Home and Tray on the origin and Home on the replica.
2. Add content on the origin. Confirm the same local uploading record appears in origin Home and
   Tray, while the replica shows no record.
3. Let the real linked provider transfer and publication finish. Confirm the origin record becomes
   published and the replica receives it without a manual refresh.
4. Add content whose provider upload will fail. Confirm one shared failed local record appears in
   origin Home and Tray with Dismiss and no Retry, and no record appears on the replica.
5. Begin an upload, close Home, and confirm publication still completes from Electron main. Quit
   during another upload, reopen the same profile, and confirm the leftover local record is failed
   and dismissible without special Quit behavior or resumed work.
6. Interrupt and restore the invalidation stream while an upload is active. Confirm both origin
   surfaces show reconnecting, the upload continues, and reconnect performs one complete refresh
   without polling, cursor, or replay behavior.
7. Delete the published Snippet. Confirm both profiles remove it and the real provider object is
   absent after the single best-effort cleanup attempt.
8. Exercise automatic hydration with more than 20 records and the strict below-1-GiB boundary.
   Confirm older and exactly-1-GiB content requires Download, existing complete managed content is
   not automatically evicted, and Copy is unavailable until integrity validation succeeds.
9. Confirm Settings reports device-local derived usage. Exercise the Home warning above 30 GiB in
   a disposable profile, then Free up space and confirm the current newest-20 content remains while
   older managed content is removed.
10. Restart both profiles and confirm account isolation, recent hydration, Download, Copy, storage
    usage, and the published snapshot remain correct.

Lost publication responses and same-size content corruption are intentionally exercised at their
deterministic Electron-main seams rather than by introducing a permanent network fault framework.

## Automated contract evidence

The focused suite maps to the contracted owners:

- Backend publication, idempotency/conflict, snapshots, transaction notification ordering, SSE
  filtering, deletion, and one-shot provider cleanup:
  `SnippetUploadsLive.test.ts`, `snippetSnapshots.test.ts`, `snippetInvalidations.test.ts`, and
  `SnippetDeletionLive.test.ts`.
- Electron-main Device Snippet records, lost-response promotion, upload lifecycle, reconnect,
  hydration, integrity, deletion, storage management, and account isolation:
  `SnippetUploadEngineLive.test.ts`, `device-records.test.ts`, `sync.test.ts`,
  `SnippetHydrationLive.test.ts`, `ManagedSnippetContentLive.test.ts`,
  `SnippetDeletionLive.test.ts`, `DesktopSessionAuthorization.test.ts`, and
  `LocalStateLive.test.ts`.
- Thin IPC and common Home/Tray presentation:
  `LocalStateIpc.test.ts`, `LocalStateViews.test.tsx`, and `SnippetRow.test.tsx`.
- Profile isolation and rejection of the superseded authoritative upload-status persistence shape:
  `lifecycle.test.ts` and `SnippetReplicaLive.test.ts`.

## Evidence record: 2026-07-23

- Base: `origin/feat/local-first` at `b4a7a055eb6a86d2432cd62b6a1d6caef7f787cf`.
- Environment: Linux GNOME/Wayland, Electron 43, local backend process using the configured
  PostgreSQL database, and two normal development Electron processes.
- Passed: backend listened on `127.0.0.1:3100`; two Electron processes concurrently reached the
  Welcome surface on separate renderer ports; their Chromium `user-data-dir` values and persisted
  Local State files resolved beneath distinct origin and replica directories.
- Passed: 114 focused lifecycle contract tests across 17 files.
- Passed: the complete `vp test` suite (232 tests across 47 files), `vp check`, and
  `vp run typecheck`.
- Passed: active source audit found no authoritative upload status, heartbeat, expiry, outbox,
  retry-generation, recovery, durable change-feed, cursor, tombstone, polling,
  retention-provenance, or automatic-eviction implementation path. Historical database migrations
  and explicitly superseded ADRs remain history, not runtime compatibility.
- Blocked: completing WorkOS authentication and linked-provider authorization required interactive
  account input. The real sign-in flow opened successfully, but protected account interaction was
  deliberately not automated or inspected.
- Data handling: no credential value, access token, provider object identifier, user identifier, or
  snippet content was recorded. The disposable validation profile directories were removed after
  the run.

| Scenario                                      | Result  | Evidence or limitation                                                                  |
| --------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| 1. Signed-in Home and Tray on two profiles    | Blocked | Both isolated profiles reached Welcome; interactive sign-in was not completed.          |
| 2. Origin-only local uploading record         | Blocked | Requires the signed-in origin and real linked provider.                                 |
| 3. Publication and PostgreSQL/SSE convergence | Blocked | Requires both signed-in profiles and a real provider upload.                            |
| 4. Shared local upload failure presentation   | Blocked | Requires the signed-in origin and an intentionally failing real upload.                 |
| 5. Close, Quit, and restart lifecycle         | Blocked | Post-auth upload lifecycle was unavailable.                                             |
| 6. SSE interruption and reconnect             | Blocked | Post-auth invalidation stream was unavailable.                                          |
| 7. Authoritative and provider deletion        | Blocked | No real provider object was created.                                                    |
| 8. Hydration, Download, Copy, and integrity   | Blocked | No authenticated Snippet content was available.                                         |
| 9. Usage warning and Free up space            | Blocked | No authenticated profile with managed content was available.                            |
| 10. Two-profile restart and isolation         | Blocked | Process-level profile isolation passed, but signed-in data isolation was not exercised. |
