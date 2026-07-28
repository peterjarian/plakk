# Shared client runtime across desktop, web, and mobile

Date: 2026-07-27

## Question

What can Plakk safely share between the existing Electron desktop client, the web
client, and a later React Native client, particularly around Effect, SQLite, and
React hooks?

This is a research note, not an architectural decision. It uses the product
language in [`CONTEXT.md`](../../CONTEXT.md) and treats the accepted ADRs as the
current constraints.

## Recommendation

Make the target a **full, React-free shared client runtime**. It should own the
product rules and long-lived orchestration that every Plakk device must perform:

- current-account transitions and sign-out cleanup;
- readable-mirror and local-state materialization;
- complete Snippet snapshot synchronization and invalidation handling;
- Snippet upload, provider transfer sequencing, and Snippet publication;
- Snippet hydration, managed-content integrity policy, and automatic file
  mirroring selection;
- Snippet deletion and device-local cleanup;
- bounded retries, concurrency, background fibers, interruption normalization,
  and lifecycle-safe shutdown.

Effect services and layers should inject the mechanics that differ by host:
authentication and credential refresh, secure storage, generic `SqlClient`,
managed content storage, source import/byte streams, provider HTTP I/O, typed
backend transport, clock/connectivity where needed, and lifecycle signals.
SQLite WASM is one web storage adapter—not the architecture.

Assemble that runtime differently in each host:

1. Electron main owns the desktop `ManagedRuntime`; renderer surfaces reach it
   only through the existing bounded IPC security seam.
2. A browser worker owns the web `ManagedRuntime`; the page reaches it through a
   typed message port.
3. A later React Native process owns the mobile `ManagedRuntime`; native modules
   provide storage, content, credentials, source, and network capabilities.
4. React uses a separate binding over one transport-neutral client interface.
   Hooks do not live inside the runtime core.

The existing SQLite-backed Snippet readable mirror is the easiest first proof:
[`SnippetReplicaLive.ts`](../../apps/desktop/src/main/snippets/replica/SnippetReplicaLive.ts)
depends only on Effect's generic `SqlClient`, while
[`Sqlite.ts`](../../apps/desktop/src/main/persistence/Sqlite.ts) supplies the
Node adapter. It should be the first vertical slice, not the final seam.
The destination is one shared client runtime containing session coordination,
upload/publication, synchronization, hydration, deletion, and local-state
orchestration after their current Electron/Node assumptions have been replaced
by capabilities.

Most importantly, this proposal must not silently weaken
[ADR-0003](../adr/0003-require-real-seams-for-effect-and-platform-modules.md).
That ADR currently requires a second implemented product client before
cross-platform orchestration is shared. The web implementation should prove,
slice by slice, that the proposed capabilities preserve the same product
invariants. Once the web adapter has proved the full seam, a follow-up ADR
should amend or supersede ADR-0003 and authorize the full shared runtime. A
desktop adapter plus a test adapter is still not evidence of a browser or mobile
seam. This affects sequencing, not the intended architecture.

## Existing ownership and portability

### What exists today

[`runtime.ts`](../../apps/desktop/src/main/runtime.ts) composes one Effect
`ManagedRuntime` in Electron main. It owns credentials, the readable mirror,
Snippet upload, managed content, Snippet hydration, remote synchronization, and
local state. This placement follows
[ADR-0002](../adr/0002-keep-protected-desktop-data-behind-electron-main.md):
protected data and shared device state remain in Electron main, while renderer
surfaces receive bounded projections and product intentions through preload and
IPC.

Electron's own process model reinforces that seam: the main process has
Node and native privileges, renderer processes run as web pages, and preload
scripts expose carefully selected APIs. Electron recommends context isolation
and one method per IPC action rather than exposing unrestricted IPC
([process model](https://www.electronjs.org/docs/latest/tutorial/process-model),
[context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation),
[security](https://www.electronjs.org/docs/latest/tutorial/security)).

The current database slice is comparatively portable:

- [`Migrations.ts`](../../apps/desktop/src/main/persistence/Migrations.ts) uses
  generic Effect SQL migrations and ordinary SQLite types and constraints.
- [`SnippetReplicaLive.ts`](../../apps/desktop/src/main/snippets/replica/SnippetReplicaLive.ts)
  uses generic `SqlClient`, transactions, JSON codecs, and a `PubSub` change
  stream.
- [`sync.ts`](../../apps/desktop/src/main/snippets/replica/sync.ts) contains the
  pure rules for atomically applying a complete Snippet snapshot while
  preserving local upload records and promoting matching identities.
- [`SnippetRemoteTransport.ts`](../../apps/desktop/src/main/snippets/replica/SnippetRemoteTransport.ts)
  already separates remote snapshot access from storage.

The current renderer API in
[`preload/index.ts`](../../apps/desktop/src/preload/index.ts) is also evidence
for a useful client-facing shape: Promise-returning product commands plus
subscriptions to bounded state. Its transport is desktop-specific, but that
shape does not have to be.

### Shared runtime versus host adapters

| Responsibility                                                                              | Final owner            | Required change                                                                                                  |
| ------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Device Snippet record schemas, complete-snapshot reconciliation, readable-mirror migrations | Shared runtime         | Move canonical types out of desktop IPC; retain generic `SqlClient`                                              |
| Current-account transitions, credential rotation response, sign-out cleanup                 | Shared runtime         | Replace desktop AuthKit service calls with `AuthSession`/`CredentialProvider` capabilities                       |
| Readable mirror and local-state materialization                                             | Shared runtime         | Replace Electron Store with a generic durable key/value or SQL-backed state capability                           |
| Snippet invalidation loop and reconnect refresh                                             | Shared runtime         | Inject authorized backend RPC/live-stream transport and connectivity/lifecycle signals                           |
| Snippet upload and publication engine                                                       | Shared runtime         | Replace `filePath` and desktop source-input payloads with opaque source handles and managed-content byte readers |
| Provider multipart/range sequencing                                                         | Shared runtime         | Inject raw HTTP request execution and readable content ranges; keep provider response rules in core              |
| Managed-content integrity, availability, retention, reclamation, and usage                  | Shared runtime         | Build common rules above a host `ContentStorage` capability                                                      |
| Snippet hydration and automatic file mirroring policy                                       | Shared runtime         | Inject download byte stream and managed-content store                                                            |
| Snippet deletion and cleanup                                                                | Shared runtime         | Inject authorized backend command transport and managed-content store                                            |
| Retry policy, concurrency limits, interruption normalization, background fibers             | Shared runtime         | Centralize under runtime lifecycle; remove Electron lifecycle calls from the algorithms                          |
| Node/WASM/React Native SQLite driver                                                        | Host adapter           | Each supplies the same generic Effect `SqlClient`                                                                |
| WorkOS flow, token storage/refresh, secure storage                                          | Host adapter           | Expose volatile session/credential capability; never expose or persist bearer tokens in local state              |
| Filesystem/OPFS/mobile byte storage                                                         | Host adapter           | Implement atomic commit, ranges/streams, enumeration/removal, and OS/storage error translation                   |
| File picker, drag/drop, clipboard/share-sheet source acquisition                            | Host adapter           | Register an opaque, scoped source; no native path enters core                                                    |
| Electron `net`, browser `fetch`, React Native networking                                    | Host adapter           | Implement backend/provider HTTP primitives and streaming support                                                 |
| Electron IPC, browser worker messages, in-process mobile calls                              | Host adapter           | Adapt the same public client interface                                                                           |
| Tray, windows, appearance, protocol callbacks, native menus                                 | Host app               | Invoke runtime commands or subscribe to projections; not runtime product logic                                   |
| React hooks                                                                                 | Separate React binding | Wrap the transport-neutral public client store; no Effect/SQL/native handle exposure                             |

Some current candidate modules import
[`ipc/contracts.ts`](../../apps/desktop/src/ipc/contracts.ts) even when their
concept is broader than IPC. Before sharing one, move the canonical value schema
to its product owner (normally `@plakk/shared` for cross-process values or the
new client package for client-owned values). IPC should encode the product
contract, not own it.

## Proposed shape

Use one initially deep package, for example `packages/client`, rather than
several speculative packages:

```text
@plakk/client
├── core
│   ├── ClientSession and account cleanup
│   ├── Device Snippet records, readable mirror, and local state
│   ├── snapshot sync and live invalidation loop
│   ├── Snippet upload/publication, hydration, and deletion
│   ├── retry/concurrency/background-fiber supervision
│   └── capability interfaces and host-neutral layers
├── runtime
│   ├── makeClientLayer(capabilities)
│   └── public Client interface and immutable snapshots
└── react
    ├── ClientProvider
    ├── useClientSnapshot / focused selectors
    └── no database or Effect service access

apps/desktop
├── Electron-main Effect assembly
├── Node SQLite/content, native source registry, WorkOS/safe credentials, Electron net
└── IPC-backed ClientPort for renderers

apps/web
├── browser-worker Effect assembly
├── WASM SQLite, OPFS content, source handles, WorkOS token and fetch adapters
└── worker-backed ClientPort

future mobile app
├── React Native Effect assembly
├── native SQLite/content, share-sheet sources, secure credentials and network adapters
└── in-process ClientPort
```

`@plakk/shared` should continue owning cross-process/API value schemas.
`@plakk/client` should own effectful client behavior and client-local
materialization. Platform assemblies can remain inside each app until repeated
adapter code justifies another package.

Effect's `Layer` is intended to compose service implementations and dependency
graphs, while `ManagedRuntime` turns a layer into a long-lived runtime with
explicit disposal
([Layer](https://effect-ts.github.io/effect/effect/Layer.ts.html),
[ManagedRuntime](https://effect-ts.github.io/effect/effect/ManagedRuntime.ts.html)).
Use those constructs inside each host assembly. At UI and transport boundaries,
adapt effects to ordinary promises, subscriptions, and structured errors.

The core should therefore not export a process-global singleton. It should
export services/layers, a constructor that accepts a capability layer, and a
plain host-facing client, conceptually:

```ts
interface ClientPort {
  getSnapshot(): ClientSnapshot;
  subscribe(listener: () => void): () => void;
  commands: ClientCommands;
  start(): Promise<void>;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  dispose(): Promise<void>;
}
```

The exact command grouping should follow product intentions, not database
operations. For example, it may expose an online Snippet deletion command; it
should not expose `query`, `execute`, `SqlClient`, or unrestricted content
reads.

Inside the runtime, Effect services should be grouped by deep responsibility,
not collected into one giant “platform” interface. Platform seams should be
primitive enough that product rules do not get reimplemented by every adapter.
A practical minimum is:

- `AuthSession`: observe account/sign-in state, obtain a short-lived credential,
  sign out, and handle a host-delivered callback result;
- `SecureCredentialStore`: load/save/clear opaque credential material where the
  host auth model permits it; a web cookie-backed `AuthSession` may satisfy this
  responsibility internally rather than exposing cookie material to the worker;
- `ClientStateStore`: persist non-secret current-account and linked-provider
  readable-mirror facts;
- generic `SqlClient`: durable Device Snippet records and migrations;
- `ContentStorage`: atomically commit durable bytes, read bounded
  ranges/streams, enumerate/remove keys, and report storage failures;
- `SnippetSourceRegistry`: resolve a host-acquired opaque source once, with
  expected metadata and an `Effect` byte stream;
- `BackendTransport`: typed account, snapshot, invalidation, prepare, publish,
  download-preparation, and deletion calls using a volatile credential;
- `ProviderHttp`: abortable upload requests and download streams with status and
  headers represented as host-neutral values;
- `ClientLifecycle`: start, foreground/resume, suspend, and shutdown signals.

Clock, randomness, logging, and scheduling can use Effect services unless a
product-level test needs a narrower capability.

The shared `ManagedSnippetContent` module sits above `ContentStorage` and
`SnippetSourceRegistry`. It owns expected-byte validation, managed-content
integrity policy, availability, prefix/text validation, local retention,
reclamation selection, usage materialization, and change publication. The
storage adapter owns the host-specific mechanics needed to satisfy atomic
commit and range-read invariants; it does not get to choose the product rules.

## Existing desktop module disposition

The following is the intended end state after the web implementation proves
each capability seam. “Move” means move the product service and orchestration
into `@plakk/client`, rename desktop-specific symbols, and leave the native
implementation in the app.

| Existing desktop module                                                                                                                                                                                                                                                                 | End state                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`persistence/Migrations.ts`](../../apps/desktop/src/main/persistence/Migrations.ts)                                                                                                                                                                                                    | Move the client schema/migrations to shared runtime                                                                                                                                                                                     |
| [`persistence/Sqlite.ts`](../../apps/desktop/src/main/persistence/Sqlite.ts)                                                                                                                                                                                                            | Keep Node driver/path/span setup in desktop; factor generic migration setup into shared runtime                                                                                                                                         |
| [`snippets/replica/SnippetReplica.ts`](../../apps/desktop/src/main/snippets/replica/SnippetReplica.ts), [`SnippetReplicaLive.ts`](../../apps/desktop/src/main/snippets/replica/SnippetReplicaLive.ts), [`sync.ts`](../../apps/desktop/src/main/snippets/replica/sync.ts), and `read.ts` | Move; remove `Desktop` tracing names and desktop IPC type ownership                                                                                                                                                                     |
| `snippets/replica/SnippetRemoteTransport*`                                                                                                                                                                                                                                              | Move the capability and invalidation/snapshot rules; inject typed authorized RPC rather than importing the desktop RPC client                                                                                                           |
| [`session/DesktopSessionLive.ts`](../../apps/desktop/src/main/session/DesktopSessionLive.ts)                                                                                                                                                                                            | Move as `ClientSessionLive`: account-generation checks, locks, cleanup, sync supervision, credential rotation response, hydration/upload pause/resume, and command authorization are cross-device orchestration                         |
| `session/DesktopAccountData*`                                                                                                                                                                                                                                                           | Move as `ClientAccountData`; purging readable mirror, local upload records, hydration work, managed content, and local state is a product invariant                                                                                     |
| `local-state/LocalState*` and `LocalStateSnippets*`                                                                                                                                                                                                                                     | Move after value schemas and `SnippetProjection` stop importing desktop IPC contracts                                                                                                                                                   |
| [`local-state/LocalStateStoreLive.ts`](../../apps/desktop/src/main/local-state/LocalStateStoreLive.ts)                                                                                                                                                                                  | Keep the Electron Store implementation and legacy migration in desktop; move the service contract or replace it with a shared durable state store                                                                                       |
| `snippets/upload/SnippetUploadEngine*`                                                                                                                                                                                                                                                  | Move after replacing `ResolvedSnippetIngestPayload`, `filePath`, and explicit access-token arguments with source/content/auth capabilities                                                                                              |
| `snippets/upload/SnippetUploadRemote*`                                                                                                                                                                                                                                                  | Move the typed prepare/publish capability or fold it into shared `BackendTransport`; host supplies authorized RPC execution                                                                                                             |
| `snippets/upload/StorageUpload*`                                                                                                                                                                                                                                                        | Move provider strategy, byte-range progression, response validation, abort/retry classification, and publication hand-off; replace Node `FileSystem` and `Blob` assumptions with shared managed-content range reads plus `ProviderHttp` |
| `snippets/hydration/SnippetHydration*`                                                                                                                                                                                                                                                  | Move automatic-selection policy, concurrency, fiber supervision, availability state, interruption, cleanup, and retry orchestration                                                                                                     |
| `snippets/hydration/SnippetHydrationTransport*`                                                                                                                                                                                                                                         | Move prepared-download validation and error classification; inject host HTTP download streaming                                                                                                                                         |
| [`snippets/deletion/SnippetDeletion.ts`](../../apps/desktop/src/main/snippets/deletion/SnippetDeletion.ts)                                                                                                                                                                              | Move; replace direct `PlakkRpcClient` use with shared backend command transport                                                                                                                                                         |
| `snippets/content/ManagedSnippetContent.ts`                                                                                                                                                                                                                                             | Move as the host-neutral product module above `ContentStorage` and `SnippetSourceRegistry`                                                                                                                                              |
| [`snippets/content/ManagedSnippetContentLive.ts`](../../apps/desktop/src/main/snippets/content/ManagedSnippetContentLive.ts)                                                                                                                                                            | Split it: move integrity, availability, retention, usage, and change rules into the shared module; keep Node path/filesystem/atomic-commit mechanics and OS error translation in a desktop `ContentStorage` adapter                     |
| `snippets/SnippetProjection.ts`                                                                                                                                                                                                                                                         | Move after its output schema becomes a client-domain projection rather than a desktop IPC type                                                                                                                                          |
| [`PlakkRpcClient.ts`](../../apps/desktop/src/main/PlakkRpcClient.ts) and `PlakkRpcClientLive.ts`                                                                                                                                                                                        | Move the typed API capability/protocol-independent mapping; each host supplies URL, HTTP/websocket/SSE implementation, CORS, and credentials                                                                                            |
| `auth/AuthService*` and `auth/AuthStore*`                                                                                                                                                                                                                                               | Keep WorkOS desktop callback mechanics and Electron safe-storage implementations in desktop; adapt them to shared `AuthSession` and secure-credential interfaces                                                                        |
| `snippets/sources/NativeFileSources*`                                                                                                                                                                                                                                                   | Keep native path registration and cleanup in desktop as one `SnippetSourceRegistry` adapter                                                                                                                                             |
| [`runtime.ts`](../../apps/desktop/src/main/runtime.ts)                                                                                                                                                                                                                                  | Keep Electron path resolution and the final desktop capability assembly; replace the current product-service graph with the shared client layer                                                                                         |
| `UserConfigStore*`, appearance, clipboard, tray/window, and Electron lifecycle/protocol wiring                                                                                                                                                                                          | Keep in desktop; call the public client where these surfaces initiate a product command                                                                                                                                                 |

The existing `DesktopSessionLive` already contains much of the eventual shared
supervisor: generation guards against stale credentials, serialized account
transitions, start/stop of the invalidation fiber, upload/hydration pause and
resume, purge ordering, and capability refresh. Its imports—not its product
rules—make it desktop-specific today.

The same distinction applies to retry policy. Retry schedules, concurrency
limits, which failures are terminal, how an interrupted local upload becomes
failed, and when background fibers stop are client product behavior. Abort
signals, timer implementation, app foreground/background events, and HTTP error
material are capabilities supplied by the host.

## Remove paths from the shared upload interface

`filePath` is the largest concrete obstacle to sharing the full upload runtime.
It appears today in the renderer source-input payload, `NativeFileSources`,
`ManagedSnippetContent.path()`, `PreparedFileUploadPayload`, and
`StorageUploadLive`. A browser may have a `File`, `Blob`, `FileSystemFileHandle`,
or drag/drop item; React Native may have a content URI, temporary share-sheet
file, or native asset. None has a portable durable pathname.

Use a two-step flow instead:

1. The host acquires a source and registers it in a `SnippetSourceRegistry`.
   The public command receives an opaque `sourceId` plus asserted file name,
   byte size, and media-type hint. The ID is meaningful only to that runtime
   instance and contains no path or bytes.
2. Shared `ManagedSnippetContent` orchestration reads that source through the
   registry, asks `ContentStorage` to atomically commit it, and applies the
   common expected-byte and integrity rules. From that point onward, the stable
   identity is `(accountId, snippetId)`, not the original host source.
3. Provider upload sequencing reads verified managed content through
   `readRange(accountId, snippetId, start, length)` or a scoped range stream.
   It never asks for a path. This preserves resumable/ranged uploads without
   loading an entire large file into memory.

A host-neutral shape is:

```ts
interface SnippetSourceRegistry {
  take(id: SourceId): Effect<SnippetSource, SourceUnavailable>;
}

interface SnippetSource {
  byteSize: number;
  stream: Stream<Uint8Array, SourceReadError>;
}

interface ContentStorage {
  putAtomically(
    key: ContentKey,
    bytes: Stream<Uint8Array>,
  ): Effect<StoredContentFacts, ContentStorageError>;
  readRange(
    key: ContentKey,
    start: number,
    length: number,
  ): Effect<Uint8Array, ContentStorageError>;
  // inspect, enumerate, remove, purge...
}
```

The exact source may optionally expose a host-private fast-import token, but
that token can only be consumed by the matching host `ContentStorage` adapter
under the shared managed-content module. Shared orchestration must always have
the stream fallback. Desktop can therefore retain an optimized same-filesystem
copy; web can stream a `File` or OPFS handle; mobile can stream a content URI.
`take` preserves the current one-shot source semantics, and the managed copy
preserves local file retention after the picker/share grant expires.

`StorageUpload` should also stop constructing a web `Blob` as its portable
contract. Shared code can calculate ranges and request verified `Uint8Array`
chunks. A `ProviderHttp` adapter turns those chunks into the host's request body
representation and returns a small neutral response `{ status, headers, json }`.
For providers or platforms that require true streaming bodies, extend the
capability with a scoped byte stream rather than exposing a path.

This separation keeps Snippet upload and publication shared:

```text
host source → atomic managed copy → prepare upload → range/stream transfer
            → publish Snippet → promote local Device Snippet record
```

Only source acquisition, byte storage, and HTTP mechanics vary.

## Platform compositions

The shared `ClientLive` layer should require the capability layer and provide
all product services plus the public facade. Each app owns only the outer
composition:

| Layer                | Electron desktop                                                                      | Web                                                                              | React Native                                                              |
| -------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Runtime owner        | Electron main                                                                         | Dedicated/shared browser worker with one database owner                          | App JS runtime, unless later evidence justifies a native/background owner |
| SQL                  | `@effect/sql-sqlite-node` at Electron user-data path                                  | `@effect/sql-sqlite-wasm` OPFS worker; in-memory degraded adapter                | `@effect/sql-sqlite-react-native` / OP-SQLite                             |
| Non-secret state     | Existing Electron Store adapter initially, preferably converged into client SQL later | SQL or a small worker-owned durable store                                        | SQL or native key/value adapter                                           |
| Credentials/auth     | WorkOS desktop callback + Electron safe storage                                       | WorkOS web session/token adapter proxied into worker, or same-origin BFF adapter | WorkOS/native browser flow + OS secure storage                            |
| Content storage      | Node filesystem atomic-commit/range adapter under shared managed-content rules        | Separate OPFS atomic-commit/range adapter under the same rules                   | Native app-storage/content-URI adapter under the same rules               |
| Source registry      | Native file paths, clipboard temp files, drag/drop                                    | `File`/`Blob`/file-handle registrations sent to worker                           | Picker/share-sheet/content-URI registrations                              |
| Backend/provider I/O | typed RPC + Electron `net.fetch`                                                      | typed RPC/live stream + browser `fetch` subject to CORS/CSP                      | typed RPC + React Native/native fetch streaming                           |
| Lifecycle            | Electron ready, protocol callback, suspend/quit                                       | hydration, visibility, page/worker shutdown, tab ownership                       | foreground/background, memory pressure, termination                       |
| UI transport         | context-isolated preload/IPC facade                                                   | versioned worker message protocol                                                | direct facade, preserving the same schemas                                |

Desktop renderers must not instantiate the shared runtime merely to resemble the
web app. That would move credentials, the readable mirror, and managed content
across the security seam rejected by ADR-0002. Shared source code does not
imply the same process placement.

The browser worker should own the complete runtime, not only SQLite. Keeping
session coordination, sync fibers, upload state, and hydration fibers together
prevents the page and worker from becoming competing orchestrators. The page
owns WorkOS React integration and DOM source acquisition, then adapts those
capabilities across a narrow message channel.

Mobile can initially run the facade and runtime in-process, but app
backgrounding must be an explicit lifecycle event. The shared runtime decides
how active work is paused or normalized; the mobile host only reports the event
and supplies platform cancellation.

## SQLite adapter findings

Plakk pins Effect `4.0.0-beta.92`. Both relevant adapters are published at that
exact version and provide the same generic `effect/unstable/sql/SqlClient`
service used by `SnippetReplicaLive`:

| Host          | Effect adapter                                  | Underlying implementation                        | Important constraints                                                                         |
| ------------- | ----------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Electron main | `@effect/sql-sqlite-node@4.0.0-beta.92`         | Native Node SQLite driver                        | Existing implementation; keep it in main                                                      |
| Browser       | `@effect/sql-sqlite-wasm@4.0.0-beta.92`         | Effect's `@effect/wa-sqlite` worker and OPFS VFS | Worker-backed client cannot stream SQL results; OPFS has single-owner/concurrency constraints |
| React Native  | `@effect/sql-sqlite-react-native@4.0.0-beta.92` | `@op-engineering/op-sqlite@15.0.4`               | Sync by default; use its scoped async-query mode for work that could block the JS thread      |

The browser adapter supports in-memory and worker-backed clients, import/export,
and a generic SQL client
([Effect SQLite WASM API](https://effect-ts.github.io/effect/docs/sql-sqlite-wasm),
[source](https://github.com/Effect-TS/effect-smol/blob/main/packages/sql/sqlite-wasm/src/SqliteClient.ts)).
Its OPFS worker uses Effect's `AccessHandlePoolVFS`
([worker source](https://github.com/Effect-TS/effect-smol/blob/main/packages/sql/sqlite-wasm/src/OpfsWorker.ts)).
The React Native adapter uses OP-SQLite and provides both synchronous execution
and a scoped asynchronous-query option
([Effect source documentation](https://effect-ts.github.io/effect/sql-sqlite-react-native/SqliteClient.ts.html)).

The current readable-mirror queries do not rely on the WASM worker client's
unsupported streaming operation. The schema uses portable `TEXT`, `INTEGER`,
foreign-key, uniqueness, and transaction behavior. This makes the replica an
excellent first compatibility target, but portability still needs an adapter
contract test suite; identical TypeScript interfaces do not guarantee identical
durability and concurrency behavior.

Effect 4 and these SQL modules are still beta/unstable APIs. Pin all Effect SQL
packages to one exact version and treat upgrades as coordinated changes, with
the cross-adapter contract suite run before merging.

## Browser runtime design

### Initialize only in the browser

The web app uses TanStack Start, whose default model includes server rendering
([overview](https://tanstack.com/start/latest/docs/framework/react/overview)).
OPFS, workers, and `navigator.storage` exist only in the browser. Do not create
the browser runtime at module scope in code that can execute during SSR. A
client provider should lazily initialize it after hydration, return an inert
server snapshot during SSR, and dispose it when its owning application lifetime
ends.

Vite supports worker imports and worker URL construction
([worker imports](https://vite.dev/guide/features.html#web-workers)).
The web spike must validate the Effect worker, WASM assets, CSP, production base
paths, and TanStack Start's client build rather than assuming a development
worker import will deploy unchanged.

### Treat OPFS as a durable cache, not authority

OPFS is origin-private and not a user-visible filesystem. Storage is best-effort
unless persistence is granted; applications can inspect quota with
`navigator.storage.estimate()`, inspect persistence with `persisted()`, and ask
for it with `persist()`
([WHATWG Storage](https://storage.spec.whatwg.org/)). Private browsing,
site-data clearing, quota pressure, and an origin change can remove the local
data. SQLite's WASM documentation also describes browser storage limitations
and OPFS behavior
([SQLite WASM persistence](https://sqlite.org/wasm/doc/tip/persistence.md)).

That is compatible with Plakk's **readable mirror**: the authoritative Snippet
set remains remote and can reconstruct published Device Snippet records from a
complete Snippet snapshot. It is not compatible with silently treating local
upload records or unique staged bytes as reconstructible. A full web runtime
must therefore separately persist and validate managed content used by a local
upload and preserve the runtime's interruption/cleanup semantics. A
readable-mirror-only milestone is useful while building, but is not completion
of the shared-runtime goal.

If OPFS is unavailable, an explicit degraded mode can use in-memory SQLite and
show that offline reading is unavailable. Do not silently claim durability.

### Coordinate database ownership

Synchronous OPFS access handles are worker-only and exclusively locked
([File System Standard](https://fs.spec.whatwg.org/)). Effect's
`AccessHandlePoolVFS` is documented as supporting only one wa-sqlite instance
and not being filesystem-transparent. Its comparison table says this VFS does
not require COOP/COEP, unlike SQLite's canonical SharedArrayBuffer-based OPFS
proxy
([Effect wa-sqlite examples](https://github.com/Effect-TS/wa-sqlite/blob/main/src/examples/README.md),
[VFS source](https://github.com/Effect-TS/wa-sqlite/blob/main/src/examples/AccessHandlePoolVFS.js)).

Therefore:

- do not create one independent database worker per browser tab;
- do not run migrations concurrently;
- choose and test a single-owner strategy before shipping offline durability.

Two plausible strategies are a SharedWorker broker shared by tabs, or
leader-election/locking that makes secondary tabs passive. The Effect OPFS
worker's support for a `MessagePort` is useful, but is not proof that multi-tab
ownership, migration serialization, crash recovery, and version upgrades are
already solved. Make the two-tab scenario a release-gating spike.

### Keep managed content separate from SQLite

SQLite portability solves Device Snippet record storage, not managed content.
The desktop currently stores complete bytes through a Node filesystem service
and supports automatic file mirroring below 1 GiB. Browser quota, stream
handling, file-picker permissions, page lifecycle, and background behavior are
different.

Implement a browser `ContentStorage` adapter around OPFS atomic commit, range
read/stream, enumeration, and removal. Keep source adoption, validation,
availability, usage, and retention in the shared `ManagedSnippetContent`
module. The content adapter should not depend on the SQLite driver's private
file layout. Do not store potentially 1 GiB blobs in the SQLite replica or move
them through a React state snapshot. The full runtime can preserve the same
automatic file mirroring rule while the web adapter reports
quota/unavailable errors through the capability. If the first shipped web
version intentionally offers less local content behavior, record that as a
product deviation rather than presenting it as full runtime parity.

## Mobile runtime design

Do not run browser SQLite WASM inside React Native. Use
`@effect/sql-sqlite-react-native@4.0.0-beta.92`, which already adapts
OP-SQLite to the generic Effect SQL client. OP-SQLite supports native
iOS/Android builds, but its installation requires native prebuilds and is not
available in Expo Go; its documentation also warns about native SQLite symbol
conflicts
([installation](https://op-engineering.github.io/op-sqlite/docs/installation/),
[configuration](https://op-engineering.github.io/op-sqlite/docs/configuration/)).

The adapter uses synchronous queries by default. Assemble replica/sync work
with its asynchronous-query option so large snapshots and migrations do not
block the React Native JavaScript thread. Validate transaction semantics under
that mode.

Expo SQLite is a possible fallback only if the eventual mobile toolchain
requires Expo Go. It would need a different Effect adapter, and its web support
is documented as alpha with separate WASM and cross-origin-isolation setup
([Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/)). It should not
be adopted now as the supposed universal database solely because it ships React
hooks.

Mobile still needs its own adapters for secure credentials, content files,
share-sheet/file inputs, backgrounding, and network reachability. The generic
SQL client proves the replica-storage seam; it does not prove the full client
runtime.

## Public runtime facade

Expose one deliberately smaller facade than the internal Effect graph. It is
the contract implemented directly in mobile, encoded over Electron IPC, and
encoded over the web worker protocol:

- lifecycle: `start`, `resume`, `suspend`, and `dispose`;
- external store: `getSnapshot` and `subscribe`;
- session intentions: begin sign-in, deliver an auth result where the host flow
  requires it, refresh, and sign out;
- Snippet intentions: register/add source, dismiss failed local upload, delete,
  download, copy/read through a bounded host-appropriate operation, and free up
  space;
- structured command results/errors, never raw Effect causes or native errors.

The facade implementation is allowed to call `ManagedRuntime.runPromise` at
this outer edge. Callers cannot request arbitrary services or run arbitrary
effects. Its snapshot is the shared **local state** materialization: current
account, cached linked storage provider, online capability, live connection
status, one Device Snippet record collection, local content availability, and
storage usage. It contains neither content bytes nor credentials.

Use Effect Schema for facade payloads and keep the worker/IPC protocols
versionable. The desktop preload may retain platform-only namespaces such as
appearance and tray alongside the shared facade; they are not forced into
`ClientCommands`.

The facade should own a cached immutable snapshot object and a single
subscription fan-out, instead of asking every UI consumer to subscribe to
Effect streams independently. This also creates one place to guard revision
ordering, translate startup failure, and disconnect listeners on disposal.

## React hooks

Create hooks, but keep them in a React binding around the host port—not in the
Effect runtime core.

React's purpose-built API for an external mutable source is
`useSyncExternalStore`. It requires a stable `subscribe` function and an
immutable cached snapshot whose identity remains unchanged until the store
changes. It also supports a deterministic `getServerSnapshot` for SSR
([React reference](https://react.dev/reference/react/useSyncExternalStore)).

Recommended binding:

- `ClientProvider` receives or lazily creates a `ClientPort`;
- `useClientSnapshot()` calls `useSyncExternalStore`;
- focused hooks such as `useSnippets()` and `useCurrentAccount()` select from
  that snapshot;
- commands remain ordinary methods returned by `useClient()` or imported
  helpers; a command is not made into a hook merely for reuse;
- no `useSqlite()`, `useEffectRuntime()`, raw SQL hook, or host-global
  `window.ipc` access leaks into reusable components.

The desktop adapter implements the port with `localState.get()` plus
`localState.onChanged()`. The web adapter implements the same port over worker
messages. Mobile can implement it in-process. This preserves
[ADR-0002's](../adr/0002-keep-protected-desktop-data-behind-electron-main.md)
renderer seam while sharing React lifecycle code.

The existing revision field in desktop local state is useful for rejecting late
initial reads, but the new store should additionally cache the exact immutable
snapshot object for `useSyncExternalStore`. During SSR, return a stable
loading/no-local-mirror snapshot; OPFS state becomes available only after the
client runtime starts.

Hooks should be extracted only after both the desktop IPC port and web worker
port pass the same store contract tests. Until then, adapting the existing
desktop hook locally is cheaper than designing a speculative universal UI API.

## Authentication and remote transport

Authentication cannot be copied from desktop unchanged.

Desktop stores credentials behind Electron main and attaches bearer tokens in
its session/RPC layer. The web app already uses WorkOS AuthKit's server session.
The official TanStack Start integration also provides an `AuthKitProvider`,
`useAuth`, and `useAccessToken`; `getAccessToken()` refreshes the browser token
when required
([official AuthKit TanStack Start README](https://github.com/workos/authkit-tanstack-start/blob/main/README.md)).

The shared core should depend on an authorization capability, not WorkOS, a
cookie, Electron safe storage, or a React hook. Two web choices remain:

1. **Direct browser RPC with bearer token.** A main-thread web auth adapter gets
   the current access token and provides it to the RPC/worker seam without
   persisting it in SQLite. This best matches the current
   [`apps/web/README.md`](../../apps/web/README.md), which says the web app does
   not proxy product RPC or live updates. It requires deliberate CORS, token
   refresh, logout, worker-message, and logging controls.
2. **Same-origin backend-for-frontend.** TanStack Start server routes hold the
   session and proxy product requests. This keeps the bearer token out of the
   browser worker, but also changes the documented architecture and adds proxy
   behavior for invalidations, upload/download streams, and errors.

Choose this with a short security and transport ADR before implementing the web
worker. The smallest continuation of the current architecture is direct bearer
RPC through a volatile access-token provider, but that is a recommendation to
validate, not an incidental runtime detail. Never persist an access token in
the readable mirror or managed-content store.

## Phased implementation

### Phase 0: prove one full browser vertical slice

Build a test-only web worker spike before moving desktop orchestration. It
should exercise the proposed capability seam end to end:

- production bundling of Effect WASM SQLite, migrations, restart durability,
  two-tab ownership, and OPFS failure modes;
- a separate OPFS managed-content adapter with atomic import, integrity,
  bounded range reads, temporary cleanup, usage, and purge;
- registration of a browser `File` without a path, atomic adoption into managed
  content, and provider range upload through the neutral HTTP capability;
- volatile WorkOS credential delivery, authenticated snapshot refresh, one
  invalidation/reconnect cycle, and sign-out purge;
- Snippet publication promotion, manual hydration, deletion, interruption, and
  worker disposal through the proposed facade.

Use fake backend/provider layers where necessary to make failures deterministic,
but also run one integration path against the real typed backend protocol. No
desktop product module needs to move during this spike. Its purpose is to
falsify bad capabilities cheaply and satisfy ADR-0003 with a real second host.

### Phase 1: establish package and contracts

1. Create `@plakk/client` with product value schemas, capability services, the
   public facade schemas, and adapter contract-test kits.
2. Move desktop IPC-owned canonical product values to `@plakk/shared` or
   `@plakk/client`; leave IPC codecs as transport adapters.
3. Add Node/WASM contract tests for SQL, managed content, source registry,
   authorized backend transport, provider HTTP, lifecycle, and facade store.
4. Implement a desktop capability layer that delegates to existing code so the
   current behavior remains the reference.

### Phase 2: move persistence, mirror, and synchronization

Move migrations, `SnippetReplica`, complete-snapshot reconciliation,
invalidation selection, local-state materialization, and the sync supervisor
into the shared runtime. Compose them with Node adapters in Electron main and
WASM/browser adapters in the worker. Validate account switches, reconnects,
stale-token generation guards, and sign-out purge on both.

### Phase 3: move content and command orchestration

1. Replace path-based source import with `SnippetSourceRegistry` and
   `ContentStorage` beneath the shared `ManagedSnippetContent` module.
2. Move Snippet upload/publication and provider range sequencing.
3. Move Snippet hydration, automatic file mirroring, free-up-space, and managed
   content integrity orchestration.
4. Move Snippet deletion and account-data cleanup.
5. Move retry/concurrency policies and all background fibers under the shared
   lifecycle supervisor.

At each step, run the same scenario against desktop and browser capability
layers. The app adapters should contain mechanics only; if a product rule
remains in an app, the extraction is not yet complete.

### Phase 4: cut over facade and React binding

1. Put desktop IPC and the browser worker protocol behind the same public client
   facade.
2. Switch both apps to the facade's immutable external store and product
   commands.
3. Extract `@plakk/client/react` using `useSyncExternalStore`.
4. Remove superseded desktop product implementations only after parity tests and
   desktop end-to-end validation pass.
5. Record a new ADR that amends or supersedes ADR-0003 for the now-proven full
   runtime seam.

### Phase 5: add mobile composition

Run every capability and runtime scenario against Effect's React Native SQLite
adapter plus native credential, managed-content, source, HTTP, and lifecycle
adapters. Reuse the core and React binding unchanged; mobile-specific code
should be limited to those adapters and UI/shell behavior.

## Release-gating test matrix

| Area                | Shared invariant                                                                                                   | Desktop stress                 | Web stress                                   | Mobile stress                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------ | -------------------------------------------- | --------------------------------- |
| SQL/readable mirror | Idempotent migrations, foreign keys, ordered records, atomic complete-snapshot replacement                         | Process/database restart       | Worker restart, two tabs, quota/private mode | App restart, async query mode     |
| Session transition  | Stale credentials cannot revive an old account; cleanup owner is retained until purge completes                    | Callback during reconnect/quit | Token refresh/logout while worker reconnects | Foreground auth return/background |
| Snapshot sync       | Invalidation is payload-free; reconnect reads a complete snapshot; active upload is not canceled by stream loss    | Electron network transition    | offline/online, worker restart               | radio/app-state transition        |
| Snippet upload      | Atomic source adoption precedes transfer; failed upload creates no Snippet; publication promotes matching identity | file changes, process quit     | picker grant loss, tab/worker termination    | content URI expiry, backgrounding |
| Provider transfer   | Correct ranges, no non-advancing loop, abort/retry classification, no whole-file buffering                         | Electron `net` failures        | CORS, fetch abort, browser memory            | native fetch/stream behavior      |
| Managed content     | Complete-byte and integrity validation, atomic writes, remove/purge/usage                                          | disk full/permissions          | quota eviction/private mode                  | device full/OS cleanup            |
| Hydration           | Newest-20 and strict below-1-GiB rule, bounded concurrency, partial cleanup, no false availability                 | quit mid-download              | worker termination/quota loss                | background/termination            |
| Deletion            | Authoritative delete precedes best-effort provider/content cleanup and mirror removal follows confirmation         | IPC command overlap            | stale secondary tab                          | app resumed after command         |
| Runtime lifecycle   | Fibers have one owner; suspend/dispose is bounded; startup normalizes interrupted local uploads                    | Electron quit                  | page/worker/tab ownership                    | foreground/background/kill        |
| Facade/store        | Cached immutable snapshots, revision ordering, structured errors, no bytes or secrets                              | IPC serialization              | worker structured clone + SSR snapshot       | in-process parity                 |

Also test that:

- no bearer token crosses desktop IPC or enters SQLite;
- secondary web tabs cannot become competing database writers;
- SSR never imports or starts browser-only storage;
- managed-content bytes do not enter React snapshots;
- a missing/corrupt local database can be rebuilt from a complete Snippet
  snapshot without inventing authoritative state.
- source handles and managed-content readers never require an application path;
- large upload/hydration scenarios keep memory bounded to the configured chunk;
- account switches interrupt old upload/hydration fibers and cannot publish into
  the new account;
- every platform runs the same scenario suite for publication response loss,
  invalidation reconnect, interrupted local upload normalization, content
  corruption, and sign-out cleanup.

## ADR interaction

- [ADR-0002](../adr/0002-keep-protected-desktop-data-behind-electron-main.md)
  remains valid. The shared runtime runs in Electron main; only the facade
  crosses IPC.
- [ADR-0003](../adr/0003-require-real-seams-for-effect-and-platform-modules.md)
  conflicts with moving the full orchestration immediately because only
  desktop implements it today. Treat this document as the target and the web
  spike as proof. Amend or supersede ADR-0003 only after the web capability
  layer demonstrates the seam.
- [ADR-0005](../adr/0005-publish-completed-snippets-and-reconcile-complete-snapshots.md)
  defines the product invariants the shared runtime must centralize: local
  upload records, publication, complete snapshots, payload-free invalidations,
  hydration, retention, and deletion ordering. Platform adapters must not
  redefine them.
- [ADR-0006](../adr/0006-keep-an-independent-live-backend.md) remains valid if
  the browser connects directly to the independent backend. Choosing a web BFF
  would amend its “TanStack Start owns browser authentication routes only”
  seam and requires a separate ADR.

## Decisions still needed

Before implementation, decide:

1. Will browser RPC use a volatile bearer-token provider or a same-origin
   backend-for-frontend?
2. Which single-owner strategy will coordinate the complete web runtime and
   OPFS across tabs?
3. Will browser managed content share an OPFS root with the database origin but
   remain a separate implementation, or use another durable browser store?
4. What degraded experience is acceptable when durable browser storage is
   unavailable?
5. Does the eventual mobile app permit native prebuilds and OP-SQLite, or does
   it require Expo Go?
6. Which lifecycle actions are product-equivalent across suspend, page close,
   background, and explicit quit, and which need host-specific policy?

The target is still the full runtime. A readable-mirror-only web milestone may
be used to reduce delivery risk, but it does not satisfy that target. The
decisions above block claiming full parity, not writing capability contracts
and the validation spike.
