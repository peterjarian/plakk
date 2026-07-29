---
status: accepted
---

# Store derived Snippet titles

Text content is immutable after a Snippet is created, so the originating client derives one optional title during upload and stores it with both the Local Snippet and published backend record. Clients render this title directly and do not download content to recover a missing title, while files without a derived text title continue to use their file name.
