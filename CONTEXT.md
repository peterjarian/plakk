# Plakk

Plakk is a personal cross-device handoff utility for making a user's snippets available across their own devices.

## Language

**Free Period**:
Plakk-owned, card-free access that ends at a deadline carried in the user's signed identity
token.
_Avoid_: Trial, Polar Trial

**Polar Trial**:
A trial attached to a Polar subscription. Polar Checkout collects a payment method before this
trial begins.
_Avoid_: Free Period

**Customer State**:
Polar's complete, authoritative view of a customer. Plakk reads it to derive a Customer Access
Snapshot but does not persist the complete response.
_Avoid_: Customer Access Snapshot, billing mirror

**Customer Access Snapshot**:
A validated, short-lived projection of the Customer State containing only facts Plakk needs to
decide paid access and present subscription cancellation state.
_Avoid_: Customer State, subscription database

**Plakk Access**:
The Polar Feature Flag benefit attached to every paid Plakk product. Its active grant is the
paid-access entitlement; product IDs only identify the monthly and yearly choices at checkout.
_Avoid_: Product entitlement, subscription product

**Payment Required**:
The access state of a user who has neither the Plakk Access benefit nor an unexpired Free Period.
_Avoid_: Sync paused, expired trial

**Snippet**:
A local-first product object created on the device as soon as the user adds content. It remains the same Snippet while uploading, after a local failure, and after publication to the backend.
_Avoid_: Upload attempt, backend-only Snippet

**Snippet upload**:
The device-local process that moves an uploading Snippet through provider transfer and publication. A failed upload leaves the Snippet visible locally but does not synchronize it to another device.
_Avoid_: Snippet ingestion, queued upload, offline upload

**Snippet publication**:
The idempotent creation of a Snippet's authoritative backend record after the linked storage provider confirms complete content. Repeating the same publication is success; attempting to reuse its identity for different content is a conflict.
_Avoid_: Upload finalization, upload completion transition, authoritative upload

**Local Snippet**:
The SQLite-backed representation of a Snippet on one device. Uploading and failed Snippets exist only on their originating device; a published Snippet also corresponds to an authoritative backend record.
_Avoid_: Device Snippet record, local upload record, second product cache

**Interrupted local upload**:
A Snippet left uploading when Plakk starts. It becomes failed and dismissible without resuming or retaining a recovery workflow.
_Avoid_: Restart recovery, automatic resume

**Orphaned provider content**:
Complete or partial provider content that has no Snippet because an upload or publication ended unexpectedly. Plakk may attempt immediate best-effort cleanup, but accepts rare orphaning rather than maintaining durable cleanup work.
_Avoid_: Snippet content, pending publication, cleanup queue

**Snippet presentation**:
The client-side interpretation of a snippet as text, a hyperlink, an image, or a general file. Presentation uses the Snippet title when present and otherwise the file name, without creating separate upload paths.
_Avoid_: Snippet kind, link snippet, text upload, file upload, image upload

**Snippet title**:
An optional, immutable label derived from text content when a Snippet is created. It is synchronized with a published Snippet so every device can display it without first reading the content.
_Avoid_: Editable name, file name

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

**Storage provider status**:
The current online assessment that a storage provider is connected for the current account, needs reauthorization, or is not connected. It is distinct from both the cached linked storage provider and the device's live invalidation connection.
_Avoid_: Pipe connection, live connection

**Snippet snapshot**:
The complete authoritative set of published Snippets for an account at refresh time. Applying it atomically replaces published local state, preserves unpublished local Snippets, promotes a matching local identity to published, and treats absence of a previously published identity as deletion.
_Avoid_: Change page, partial snapshot, event batch

**Snippet invalidation**:
A payload-free live signal that the authoritative Snippet set may have changed. It has no ordering, history, replay, or domain payload; devices respond by reading a complete Snippet snapshot after the signal or after reconnecting.
_Avoid_: Snippet event, change feed, cursor update

**Readable mirror**:
The device-owned, durable copy of last-confirmed remote facts needed for local reading: the current account, linked storage provider, and published local Snippets. Its published state is replaced only from one authoritative source and never accepts competing offline mutations.
_Avoid_: Local authority, offline mutation store, renderer cache

**Local state**:
The device-owned representation of everything app surfaces need to present consistently: one Local Snippet collection, the readable mirror, live connection status, local content availability, and storage usage. Surfaces read this same materialization rather than combining independent upload and Snippet collections.
_Avoid_: Renderer store, server snapshot, authoritative local state

**Screen-local optimistic update**:
A transient renderer-owned presentation of an interaction that does not alter Local Snippets. It is not written to local state, broadcast to other windows, or retained across restart.
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
