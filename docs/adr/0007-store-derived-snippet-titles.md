---
status: accepted
---

# Store derived Snippet titles

Text content is immutable after a Snippet is created, so the originating client derives one optional title during upload and stores it with both the Local Snippet and published backend record. Synchronizing that title avoids requiring every device to read content before it can render the Snippet, while files without a derived text title continue to use their file name.
