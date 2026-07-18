---
status: accepted
---

# Require real seams for Effect and platform modules

Plakk uses Effect module shapes for deep effectful modules with lifecycle, state, resources, external I/O, or replaceable dependencies. Pure rules and single-owner helpers remain ordinary functions inside their owning module; thin forwarding modules and separate `Live` files are not created for ceremony. Interface and implementation stay together when that improves locality, and split only when package ownership or real adapters require a seam.

Cross-platform orchestration is shared only after at least two real product clients need the same invariant and their variation fits behind a small capability-level interface. A production adapter plus a test adapter proves an external seam, not a desktop/mobile/browser product seam. Desktop upload orchestration is therefore deepened in the desktop app first; sharing it across product clients waits for a second implemented client. The backend storage-provider seam remains real because Google Drive, OneDrive, and Dropbox already provide distinct adapters.
