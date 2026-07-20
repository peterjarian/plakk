# Plakk

Plakk is a personal cross-device handoff utility for making a user's snippets available across their own devices.

## Language

**Snippet**:
An authoritative record for complete content stored in the user's linked storage provider. It exists only after the provider content is complete and Snippet publication succeeds.
_Avoid_: Upload activity, pending upload, incomplete Snippet

**Snippet upload**:
The device-local process of obtaining a provider upload destination, transferring complete content, and then publishing a Snippet. A failed upload creates no Snippet and is never synchronized to another device.
_Avoid_: Snippet ingestion, queued upload, offline upload

**Snippet publication**:
The idempotent creation of a Snippet after the linked storage provider confirms complete content. Repeating the same publication is success; attempting to reuse its identity for different content is a conflict.
_Avoid_: Upload finalization, upload completion transition, authoritative upload

**Device Snippet record**:
A record in the single device-owned collection presented to Home and Tray. It is either a local upload record or a published Snippet record; only the published form represents authoritative shared work.
_Avoid_: Combined renderer list, upload-attempt collection, second product cache

**Local upload record**:
The device-only form of a Device Snippet record before publication. It is uploading or failed, never synchronizes to another device, offers Dismiss rather than Retry after failure, and becomes a published record when the backend snapshot or publication response contains the same identity.
_Avoid_: Snippet, authoritative upload status, queued work, recoverable upload

**Interrupted local upload**:
A local upload record left uploading when Plakk starts. It becomes failed and dismissible without resuming or retaining a recovery workflow.
_Avoid_: Restart recovery, automatic resume, interrupted Snippet

**Orphaned provider content**:
Complete or partial provider content that has no Snippet because an upload or publication ended unexpectedly. Plakk may attempt immediate best-effort cleanup, but accepts rare orphaning rather than maintaining durable cleanup work.
_Avoid_: Snippet content, pending publication, cleanup queue

**Snippet presentation**:
The client-side interpretation of a snippet as text, a hyperlink, an image, or a general file, including its display title. Presentation is derived from the file name and content; it is not authoritative snippet metadata and does not create separate upload paths.
_Avoid_: Snippet kind, stored title, link snippet, text upload, file upload, image upload

**File name**:
The name under which a snippet's file content is stored in the linked storage provider, such as `file.md`. It is authoritative snippet metadata but is neither a display title nor a local source path.
_Avoid_: Snippet title, source path

**Byte size**:
The expected byte count of a snippet's complete file content. Provider content and locally managed content must correspond to this size rather than silently redefining it.
_Avoid_: Transfer progress

**Media type hint**:
A best-effort description of a snippet's file representation supplied during upload or by a storage provider. It may assist transfer, but it does not define snippet presentation and is not authoritative snippet metadata.
_Avoid_: Authoritative content type

**Current account**:
The account most recently confirmed as signed in on a device and not subsequently signed out. Its cached identity may be displayed offline but does not prove that online commands are currently available.
_Avoid_: Active token, online session

**Linked storage provider**:
The storage provider most recently confirmed as linked to the current account. The cached provider remains displayable offline but does not imply that the provider is currently reachable.
_Avoid_: Available provider, live connection

**Snippet snapshot**:
The complete authoritative set of Snippet records for an account at refresh time. Applying it atomically replaces published device records, preserves local upload records, promotes a matching local identity to published, and treats absence of a previously published identity as deletion.
_Avoid_: Change page, partial snapshot, event batch

**Snippet invalidation**:
A payload-free live signal that the authoritative Snippet set may have changed. It has no ordering, history, replay, or domain payload; devices respond by reading a complete Snippet snapshot after the signal or after reconnecting.
_Avoid_: Snippet event, change feed, cursor update

**Readable mirror**:
The device-owned, durable copy of last-confirmed remote facts needed for local reading: the current account, linked storage provider, and published Device Snippet records. Its published records are replaced only from one authoritative source and never accept competing offline mutations.
_Avoid_: Local authority, offline mutation store, renderer cache

**Local state**:
The device-owned representation of everything desktop surfaces need to present consistently: the readable mirror, one Device Snippet collection, live connection status, local content availability, and storage usage. Home and Tray infer presentation from this same materialization rather than combining independent upload and Snippet collections.
_Avoid_: Renderer store, server snapshot, authoritative local state

**Screen-local optimistic update**:
A transient renderer-owned presentation of an interaction that does not alter Device Snippet records. It is not written to local state, broadcast to other windows, or retained across restart.
_Avoid_: Cross-window optimistic state, offline mutation, durable optimistic journal

**Live connection status**:
The device's connected or reconnecting assessment of its authenticated invalidation stream. It communicates synchronization freshness and triggers a complete refresh after reconnect, but does not cancel active uploads or replace the actual result of a backend command.
_Avoid_: Universal network truth, upload lease, polling status

**Local content availability**:
The device-owned state of a Snippet's managed content: available, not available, or downloading. Failed or interrupted downloads discard partial bytes, return to not available, and may present a process-local error without creating durable recovery state.
_Avoid_: Snippet status, global availability, sync status

**Managed content integrity**:
The requirement that locally available content matches the snippet's expected complete bytes. Missing, partial, or corrupt content invalidates local availability and is never served to the user.
_Avoid_: Best-effort cache hit, trusted availability flag, presentation validity

**Snippet hydration**:
The presentation-agnostic process that copies complete provider content into atomic managed content on a device. A failed attempt discards partial bytes and may be started again later without durable failure or Retry state.
_Avoid_: Copy download, text hydration, renderer fetch

**Automatic file mirroring**:
The per-device process that hydrates content for the newest 20 Snippets whose byte size is strictly below 1 GiB (`1,073,741,824` bytes). It decides what to fetch automatically but never evicts content that already exists locally.
_Avoid_: Full-history mirroring, age-based retention, synchronized download preference

**Local file retention**:
The device-local preservation of complete content after automatic hydration, explicit Download, or upload from that device. Content remains until Snippet deletion, sign-out, or the user frees space; Plakk does not track separate automatic and explicit retention origins.
_Avoid_: Retention provenance, automatic eviction, temporary preview

**Local storage usage**:
The total bytes currently occupied by Plakk-managed content on a device, derived from the managed files rather than maintained as a separate counter. Home warns above 30 GiB and directs the user to storage settings.
_Avoid_: Storage quota, synchronized usage, persisted byte counter

**Free up space**:
The device-local action that removes managed content outside the automatically maintained newest-20 set without deleting Snippet records or provider content.
_Avoid_: Delete Snippets, clear authoritative history, disable mirroring

**Snippet deletion**:
The authoritative removal of a Snippet through an online command. The Snippet disappears before provider cleanup is attempted; cleanup is best-effort and cannot restore or delay the deletion.
_Avoid_: Local tombstone, canceled upload, durable cleanup work
