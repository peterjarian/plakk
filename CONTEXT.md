# Plakk

Plakk is a personal cross-device handoff utility for making a user's snippets available across their own devices.

## Language

**Snippet**:
A piece of content a user puts into Plakk to make available on their other devices. Every snippet has metadata and file content stored in the user's linked storage provider.

**Snippet ingestion**:
The origin-local process of turning source content into durable managed bytes and a queued snippet. Source content is not a snippet until both managed content and the local outbox entry are durable; a failure before that point remains a local import error.
_Avoid_: Failed upload before enqueue

**Missing managed content**:
A failure discovered after a snippet was durably queued when its origin no longer has the expected managed bytes. The snippet remains visible but cannot be retried; the origin may remove it, while replacing the content creates a new snippet.
_Avoid_: Import failure, retryable upload failure

**Snippet presentation**:
The client-side interpretation of a snippet as text, a hyperlink, an image, or a general file, including its display title. A shared library derives presentation from the file name and content; it is not authoritative snippet metadata and does not create separate upload paths.
_Avoid_: Snippet kind, stored title, link snippet, text upload, file upload, image upload

**File name**:
The name under which a snippet's file content is uploaded to the linked storage provider, such as `file.md`. It is preserved as authoritative snippet metadata but is neither a display title nor a local source path.
_Avoid_: Snippet title, source path

**Byte size**:
The expected byte count of a snippet's managed file content, fixed when the content is ingested. A completed provider object must correspond to this size rather than silently redefining it.
_Avoid_: Transfer progress

**Media type hint**:
A best-effort description of a snippet's file representation supplied by an origin client or storage provider. It may assist transfer, but it does not define snippet presentation and is not authoritative snippet metadata.
_Avoid_: Authoritative content type

**Origin client**:
The specific app installation that accepts and durably stores a snippet's source content. Its local outbox owns uploading that content across process and window restarts; synchronization shares authoritative state, not unfinished content or upload work. Origin ownership is a client workflow fact, not a separate server authorization identity.
_Avoid_: Platform, source device

**Upload status**:
The server-owned state of a snippet's upload after its metadata becomes authoritative. `UPLOADING`, `FAILED`, and `UPLOADED` are synchronized to every client so each surface can present the same state; local `QUEUED` state is not an upload status. The origin may make a bounded number of retries before publishing `FAILED`. Once published, `FAILED` remains stable until the user retries on the origin or deletes the snippet; retry moves it back to `UPLOADING`.
_Avoid_: Sync status, local upload state

**Upload failure detail**:
Origin-local information explaining why an upload is currently failing and how that origin may recover or retry it. Other clients synchronize only the authoritative `FAILED` status.
_Avoid_: Authoritative failure message, synchronized provider error

**Snippet deletion**:
Removal of a snippet regardless of whether it is queued, uploading, failed, or uploaded. Deletion wins over unfinished work and late completion; cancellation is not a separate snippet state.
_Avoid_: Canceled upload status

**Upload heartbeat deadline**:
The time until which the server may trust that an origin client is still transferring a snippet directly to its linked storage provider. After expiry, the server independently publishes authoritative `FAILED`; ownership does not transfer to another client.
_Avoid_: Upload lock, ownership lease
