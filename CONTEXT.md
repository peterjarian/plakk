# Plakk

Plakk is a personal cross-device handoff utility for making a user's snippets available across their own devices.

## Language

**Snippet**:
An authoritative record for a piece of content a user is uploading or has uploaded across their devices. Its upload status is `UPLOADING`, `CLIENT_UPLOAD_FAILED`, `STORAGE_UPLOAD_FAILED`, `FINALIZATION_FAILED`, or `UPLOADED`.
_Avoid_: Local upload activity, queued local work

**Snippet upload**:
The process that first prepares and verifies stable source content on the originating device, then creates an authoritative `UPLOADING` snippet, transfers the content to provider storage, and commits it as `UPLOADED`. Other devices observe the snippet once provider transfer is ready to begin, not during local preparation.
_Avoid_: Snippet ingestion, queued upload, offline upload

**Upload activity**:
Device-local detail about local preparation, active transfer, or recoverable failure or interruption. It may exist before a Snippet: a returned backend creation error is presented locally as `Upload failed` with Retry and Remove, while `Interrupted` is reserved for process exit with work still in flight; recoverable activity persists only on the origin and exposes no byte progress.
_Avoid_: Authoritative progress, queued snippet, upload percentage

**Upload status**:
The authoritative, synchronized state of a snippet: `UPLOADING` while the origin transfers provider content; `CLIENT_UPLOAD_FAILED` when the originating client cannot complete the transfer, loses its network connection, or misses its heartbeat deadline; `STORAGE_UPLOAD_FAILED` when the linked storage provider reports a terminal rejection or provider-side failure; `FINALIZATION_FAILED` when the provider confirms a complete upload but the backend cannot finalize it; and `UPLOADED` once provider content and metadata are committed. Failure status remains visible on every device until explicit retry or deletion.
_Avoid_: Local progress, download status, local content availability, generic failed status

**Upload failure presentation**:
The concise UI mapping of authoritative upload failures. `CLIENT_UPLOAD_FAILED` is shown as `Upload failed`, `STORAGE_UPLOAD_FAILED` as `Storage issue`, and `FINALIZATION_FAILED` as `Couldn't finish`, each with a cross icon. On the originating device, a persisted local recovery state proving that the application exited mid-upload overrides `Upload failed` with `Interrupted`. The origin offers Retry and Delete; other devices offer only Delete. Detailed diagnostics remain secondary.
_Avoid_: Raw status enum, every client failure is interrupted, diagnostic failure sentence

**Upload heartbeat deadline**:
The time until which the backend may trust that the uploading device is still attempting a snippet upload. The device extends the deadline while active; client failure or deadline expiry makes upload status `CLIENT_UPLOAD_FAILED`.
_Avoid_: Upload lock, ownership lease, local retry timer

**Upload retry**:
Recovery by the originating device while it retains verified staged source content and recovery metadata. Transient failures retry automatically while status remains `UPLOADING`; after interruption or authoritative failure, the origin may retry explicitly across application restarts. Retrying `CLIENT_UPLOAD_FAILED` or `STORAGE_UPLOAD_FAILED` transfers the staged bytes again. Retrying `FINALIZATION_FAILED` reuses the persisted provider object reference and invokes only idempotent backend finalization, transferring no file bytes; authoritative status remains `FINALIZATION_FAILED` during that request and changes directly to `UPLOADED` on success. Other devices cannot retry, and the upload never resumes automatically.
_Avoid_: Cross-device retry, automatic retry after restart, offline retry, failure on first transient error

**Upload cancellation**:
The originating device's explicit removal of an `UPLOADING` snippet. Cancellation deletes the authoritative snippet for every device and removes staged recovery content; application exit is interruption rather than cancellation.
_Avoid_: Failed upload, paused upload, local cancellation

**Interrupted upload**:
An origin-local recovery state created when the application process exits while upload work is still in flight. If an authoritative Snippet already exists it becomes failed through an explicit signal or heartbeat expiry, while verified staged content and recovery metadata remain available for user-initiated Retry after reopening.
_Avoid_: Automatic resume, canceled upload, queued upload

**Abandoned provider content**:
Provider upload sessions or objects left behind by `CLIENT_UPLOAD_FAILED`, `STORAGE_UPLOAD_FAILED`, or cancellation. Plakk attempts immediate cleanup when it can identify them, but cleanup is best-effort and does not delay authoritative failure or removal. A confirmed provider object retained for `FINALIZATION_FAILED` Retry is recoverable snippet content, not abandoned content.
_Avoid_: Snippet content, durable cleanup work, locally managed content

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

**Readable mirror**:
The device-owned, durable copy of last-confirmed remote facts needed for local reading: the current account, linked storage provider, and all snippet records including their upload status. It is refreshed from one authoritative source and never accepts competing local mutations.
_Avoid_: Local authority, offline mutation store, renderer cache

**Local state**:
The device-owned representation of everything desktop surfaces need to present consistently: the readable mirror, current online capability, local content availability, and device-local upload activity. It is a materialization of authoritative and device-owned facts, not an independent authority.
_Avoid_: Renderer store, server snapshot, authoritative local state

**Screen-local optimistic update**:
A transient renderer-owned presentation of an online command on the screen that invoked it. It is not written to the readable mirror, broadcast to other windows, or retained across restart. Confirmed local staging or authoritative backend changes replace it through the local state; command failure rolls it back and presents an error on the invoking screen.
_Avoid_: Cross-window optimistic state, offline mutation, durable optimistic journal

**Online capability**:
The device's current ability to synchronize or perform a command that requires the backend or linked storage provider. Losing online capability preserves the readable mirror and locally available content.
_Avoid_: Signed-in user, cached account, sync status

**Local content availability**:
The device-owned state of an `UPLOADED` snippet's managed file content: available, not available, downloading, or locally failed. Stable availability and failure are retained in persistent local storage across application restarts, while active downloading exists only during the current process. Automatic and manual downloads make bounded transient retries, then become locally failed and require explicit Retry rather than continuing indefinitely. A not-available file must be downloaded before it can be copied; downloading is shown as indeterminate activity rather than byte progress. Availability is not synchronized to other devices and does not change upload status.
_Avoid_: Upload status, global availability, sync status

**Interrupted download**:
A device-local download that ended because the application process exited before managed content became available. It persists across restart and is presented with a cross icon, `Interrupted`, and Retry rather than a diagnostic failure sentence. The transfer never resumes automatically.
_Avoid_: Failed - Download interrupted, synchronized failure, partial download

**Managed content integrity**:
The requirement that locally available content matches the snippet's expected complete bytes. Missing, partial, or corrupt content invalidates local availability and is never served to the user.
_Avoid_: Best-effort cache hit, trusted availability flag, presentation validity

**Snippet hydration**:
The presentation-agnostic process that copies an `UPLOADED` snippet's provider content into atomic managed content on a device. Hydration changes local content availability, not upload status.
_Avoid_: Copy download, text hydration, renderer fetch

**Automatic file mirroring**:
The per-device process that hydrates every `UPLOADED` snippet whose file content is strictly smaller than 1 GiB (`1,073,741,824` bytes), regardless of age. Exactly 1 GiB does not qualify. Every device still mirrors the snippet record regardless of content size; content is a separate device-local concern.
_Avoid_: Smart offline retention, age-based retention, synchronized download preference

**Manual file retention**:
The device-local choice to retain `UPLOADED` content that does not qualify for automatic file mirroring, either by downloading it or uploading it from that device. The snippet remains visible before download, with a download action instead of copy, and retained content stays available until the snippet is deleted.
_Avoid_: Global download, synchronized retention, temporary preview

**Snippet deletion**:
The authoritative removal of a snippet through an online command. The invoking screen may hide it optimistically, but the readable mirror and other windows change only after backend confirmation. The backend removes the snippet and publishes its deletion without waiting for provider cleanup; deleting the provider file is a best-effort side effect that cannot restore or delay the snippet deletion. Command failure restores the invoking screen from the unchanged local state.
_Avoid_: Local tombstone, optimistic replica deletion, canceled upload
