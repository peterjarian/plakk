import { SqliteClient } from "@effect/sql-sqlite-wasm";
import {
  Client,
  type ClientSnapshot,
  clearClientMetadata,
  clientLayer,
  CurrentSession,
  OfflineError,
  SessionError,
  type Snippet,
} from "@plakk/client-runtime";
import {
  decodeSnippetText,
  decodeSnippetTextPreview,
  deriveSnippetPresentation,
  isTextSnippetFileName,
  type User,
} from "@plakk/shared";
import { accountCanSyncWithConnection } from "@plakk/shared/PlakkApi";
import {
  ProductApp,
  type ProductAppProps,
  type ProductSnippet,
} from "@plakk/ui/components/ProductApp";
import { useAuth, useAccessToken } from "@workos/authkit-tanstack-react-start/client";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const rpcUrl = import.meta.env.VITE_PLAKK_RPC_URL ?? "http://localhost:3100/api/rpc";
const TEXT_PREVIEW_MAX_BYTES = 64 * 1024;
const TEXT_PREVIEW_LIMIT = 50;
const BUFFERED_CONTENT_MAX_BYTES = 64 * 1024 * 1024;
const databaseNameFor = (userId: string) => `plakk-${userId}.sqlite`;
const databaseLockNameFor = (userId: string) => `plakk:sqlite:${databaseNameFor(userId)}`;
const runtimeChannelNameFor = (userId: string) => `plakk:runtime:${userId}`;
const downloadLockNameFor = (temporaryName: string) => `plakk:download:${temporaryName}`;

type RuntimeResource = {
  readonly client: Client["Service"];
  readonly runtime: ManagedRuntime.ManagedRuntime<Client, unknown>;
};

const messageFrom = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim() ? cause.message : fallback;

const collectBytes = <E,>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunks) => {
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }),
  );

const downloadBlob = (blob: Blob, fileName: string, onRevoke: () => void) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.hidden = true;
  anchor.href = url;
  anchor.download = fileName.split(/[\\/]/).filter(Boolean).pop() ?? "snippet";
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
    onRevoke();
  }, 60_000);
};

const sweepTemporaryDownloads = async () => {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("plakk-downloads", { create: true });
  for await (const temporaryName of directory.keys()) {
    await navigator.locks.request(
      downloadLockNameFor(temporaryName),
      { ifAvailable: true },
      async (lock) => {
        if (lock !== null) await directory.removeEntry(temporaryName).catch(() => {});
      },
    );
  }
};

const ensureBufferable = (snippet: Pick<ProductSnippet, "byteSize">) => {
  if (snippet.byteSize > BUFFERED_CONTENT_MAX_BYTES) {
    throw new Error("This snippet is too large to open in the browser.");
  }
};

const makeSqliteLayer = (databaseName: string) =>
  SqliteClient.layer({
    worker: Effect.acquireRelease(
      Effect.sync(
        () =>
          new Worker(new URL("./sqlite-worker.ts", import.meta.url), {
            name: databaseName,
            type: "module",
          }),
      ),
      (worker) => Effect.sync(() => worker.terminate()),
    ),
  });

const projectSnippet = (snippet: Snippet, preview: string | undefined): ProductSnippet => ({
  id: snippet.id,
  fileName: snippet.fileName,
  byteSize: snippet.byteSize,
  storageProvider: snippet.storageProvider,
  createdAt: snippet.createdAt,
  updatedAt: snippet.updatedAt,
  kind: snippet.status === "PUBLISHED" ? "PUBLISHED" : "LOCAL",
  localState:
    snippet.status === "PUBLISHED"
      ? null
      : {
          status: snippet.status === "FAILED" ? "FAILED" : "UPLOADING",
          errorMessage: snippet.status === "FAILED" ? snippet.errorMessage : null,
        },
  localContentAvailability: snippet.localContentAvailability,
  presentation:
    preview === undefined && isTextSnippetFileName(snippet.fileName)
      ? { type: "text", title: "Text snippet" }
      : deriveSnippetPresentation({
          fileName: snippet.fileName,
          ...(preview === undefined ? {} : { content: preview }),
        }),
});

const useAppearance = () => {
  const [preference, setPreference] = useState<ProductAppProps["appearance"]>(() => {
    if (typeof localStorage === "undefined") return "system";
    const stored = localStorage.getItem("plakk-appearance");
    return stored === "light" || stored === "dark" ? stored : "system";
  });

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = preference === "dark" || (preference === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  return {
    preference,
    set: async (next: ProductAppProps["appearance"]) => {
      localStorage.setItem("plakk-appearance", next);
      setPreference(next);
    },
  };
};

export function WebProduct() {
  const auth = useAuth();
  const accessToken = useAccessToken();
  const getAccessTokenRef = useRef(accessToken.getAccessToken);
  getAccessTokenRef.current = accessToken.getAccessToken;
  const signOutRef = useRef(auth.signOut);
  signOutRef.current = auth.signOut;
  const resourceRef = useRef<RuntimeResource | null>(null);
  const previewingRef = useRef(new Set<string>());
  const previewFailuresRef = useRef(new Map<string, number>());
  const previewRetryTimersRef = useRef(new Map<string, number>());
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [previewRetryTick, setPreviewRetryTick] = useState(0);
  const appearance = useAppearance();

  useEffect(() => {
    void sweepTemporaryDownloads().catch(() => {});
  }, []);

  const user: User | null =
    auth.user === null
      ? null
      : {
          id: auth.user.id,
          firstName: auth.user.firstName,
          lastName: auth.user.lastName,
          email: auth.user.email,
          createdAt: auth.user.createdAt,
          updatedAt: auth.user.updatedAt,
        };

  useEffect(() => {
    if (user === null) {
      setSnapshot(null);
      setPreviews({});
      setRuntimeLoading(false);
      return;
    }

    let active = true;
    setRuntimeLoading(true);
    setRuntimeError(null);
    setSnapshot(null);
    setPreviews({});
    previewingRef.current.clear();
    previewFailuresRef.current.clear();
    for (const timer of previewRetryTimersRef.current.values()) window.clearTimeout(timer);
    previewRetryTimersRef.current.clear();
    const lockAbort = new AbortController();
    let runtime: RuntimeResource["runtime"] | null = null;
    const runtimeChannel = new BroadcastChannel(runtimeChannelNameFor(user.id));
    runtimeChannel.addEventListener("message", (event) => {
      if (event.data !== "release") return;
      active = false;
      lockAbort.abort();
      const acquiredRuntime = runtime;
      runtime = null;
      if (resourceRef.current?.runtime === acquiredRuntime) resourceRef.current = null;
      setSnapshot(null);
      setPreviews({});
      setRuntimeLoading(false);
      setRuntimeError(null);
      void (async () => {
        if (acquiredRuntime !== null) await acquiredRuntime.dispose();
        await signOutRef.current({ returnTo: "/" });
      })();
    });

    const sessionLayer = Layer.succeed(
      CurrentSession,
      CurrentSession.of({
        user,
        accessToken: Effect.tryPromise({
          try: async () => {
            const token = await getAccessTokenRef.current();
            if (token === undefined) {
              throw new SessionError({
                message: "Your session expired. Sign in again to continue.",
              });
            }
            return token;
          },
          catch: (cause) =>
            Schema.is(SessionError)(cause)
              ? cause
              : new OfflineError({
                  message: "Plakk could not refresh your session.",
                }),
        }),
      }),
    );
    const databaseName = databaseNameFor(user.id);
    void navigator.locks
      .request(
        databaseLockNameFor(user.id),
        { ifAvailable: true, signal: lockAbort.signal },
        async (lock) => {
          if (lock === null) {
            if (active) {
              setRuntimeLoading(false);
              setRuntimeError("Plakk is already open in another browser tab.");
            }
            return;
          }
          if (!active) return;
          const sqliteLayer = makeSqliteLayer(databaseName);
          const protocolLayer = RpcClient.layerProtocolHttp({ url: rpcUrl }).pipe(
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provideMerge(RpcSerialization.layerNdjson),
          );
          const acquiredRuntime = ManagedRuntime.make(
            clientLayer.pipe(
              Layer.provide(Layer.mergeAll(sessionLayer, sqliteLayer, protocolLayer)),
            ),
          );
          runtime = acquiredRuntime;
          try {
            await acquiredRuntime.runPromise(
              Effect.gen(function* () {
                const client = yield* Client;
                if (active) resourceRef.current = { client, runtime: acquiredRuntime };
                yield* client.subscribe().pipe(
                  Stream.runForEach((next) =>
                    Effect.sync(() => {
                      if (!active) return;
                      setSnapshot(next);
                      setRuntimeLoading(false);
                    }),
                  ),
                );
              }),
            );
          } finally {
            if (resourceRef.current?.runtime === acquiredRuntime) resourceRef.current = null;
            if (runtime === acquiredRuntime) runtime = null;
            await acquiredRuntime.dispose();
          }
        },
      )
      .catch((cause) => {
        if (!active) return;
        setRuntimeLoading(false);
        setRuntimeError(messageFrom(cause, "Plakk could not start in this browser."));
      });

    return () => {
      active = false;
      lockAbort.abort();
      runtimeChannel.close();
      for (const timer of previewRetryTimersRef.current.values()) window.clearTimeout(timer);
      previewRetryTimersRef.current.clear();
      const acquiredRuntime = runtime;
      if (acquiredRuntime !== null) {
        if (resourceRef.current?.runtime === acquiredRuntime) resourceRef.current = null;
        void acquiredRuntime.dispose();
      }
    };
  }, [runtimeAttempt, user?.id]);

  useEffect(() => {
    const resource = resourceRef.current;
    if (resource === null || snapshot === null) return;
    const candidates = snapshot.snippets
      .slice(0, TEXT_PREVIEW_LIMIT)
      .filter(
        (snippet) =>
          snippet.status === "PUBLISHED" &&
          isTextSnippetFileName(snippet.fileName) &&
          snippet.byteSize <= TEXT_PREVIEW_MAX_BYTES &&
          previews[snippet.id] === undefined &&
          !previewingRef.current.has(snippet.id),
      );
    for (const snippet of candidates) {
      previewingRef.current.add(snippet.id);
    }
    void resource.runtime
      .runPromise(
        Effect.forEach(
          candidates,
          (snippet) =>
            collectBytes(resource.client.content.readRemote(snippet.id)).pipe(
              Effect.tap((bytes) =>
                Effect.sync(() => {
                  previewFailuresRef.current.delete(snippet.id);
                  const retryTimer = previewRetryTimersRef.current.get(snippet.id);
                  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
                  previewRetryTimersRef.current.delete(snippet.id);
                  const preview = decodeSnippetTextPreview(bytes);
                  if (preview !== null) {
                    setPreviews((current) => ({ ...current, [snippet.id]: preview }));
                  }
                }),
              ),
              Effect.catch((error) =>
                error._tag === "OfflineError" || error._tag === "ServerUnavailableError"
                  ? Effect.sync(() => {
                      if (previewRetryTimersRef.current.has(snippet.id)) return;
                      const failures = (previewFailuresRef.current.get(snippet.id) ?? 0) + 1;
                      previewFailuresRef.current.set(snippet.id, failures);
                      const timer = window.setTimeout(
                        () => {
                          previewRetryTimersRef.current.delete(snippet.id);
                          setPreviewRetryTick((tick) => tick + 1);
                        },
                        Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)),
                      );
                      previewRetryTimersRef.current.set(snippet.id, timer);
                    })
                  : Effect.void,
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  previewingRef.current.delete(snippet.id);
                }),
              ),
            ),
          { concurrency: 4, discard: true },
        ),
      )
      .catch(() => {
        // Runtime disposal can interrupt an in-flight preview batch.
      });
  }, [previewRetryTick, previews, snapshot]);

  const withClient = useCallback(
    async <A,>(run: (resource: RuntimeResource) => Promise<A>): Promise<A> => {
      const resource = resourceRef.current;
      if (resource === null) throw new Error("Plakk is still starting.");
      return run(resource);
    },
    [],
  );

  const readRemote = useCallback(
    (snippetId: string) =>
      withClient((resource) =>
        resource.runtime.runPromise(collectBytes(resource.client.content.readRemote(snippetId))),
      ),
    [withClient],
  );

  const downloadRemote = useCallback(
    (snippet: ProductSnippet) =>
      withClient(async (resource) => {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle("plakk-downloads", { create: true });
        const temporaryName = crypto.randomUUID();
        await new Promise<void>((resolve, reject) => {
          void navigator.locks
            .request(downloadLockNameFor(temporaryName), async () => {
              const handle = await directory.getFileHandle(temporaryName, { create: true });
              const writable = await handle.createWritable();
              try {
                await resource.runtime.runPromise(
                  resource.client.content
                    .readRemote(snippet.id)
                    .pipe(
                      Stream.runForEach((chunk) =>
                        Effect.tryPromise(() => writable.write(Uint8Array.from(chunk))),
                      ),
                    ),
                );
                await writable.close();
                const file = await handle.getFile();
                await new Promise<void>((revoke) => {
                  downloadBlob(file, snippet.fileName, revoke);
                  resolve();
                });
                await directory.removeEntry(temporaryName).catch(() => {});
              } catch (cause) {
                await writable.abort().catch(() => {});
                await directory.removeEntry(temporaryName).catch(() => {});
                reject(cause);
              }
            })
            .catch(reject);
        });
      }),
    [withClient],
  );

  const capability =
    snapshot?.capability ??
    ({
      status: "OFFLINE",
      storageProvider: { known: false, value: null },
    } as const);
  const snippets = useMemo(
    () => snapshot?.snippets.map((snippet) => projectSnippet(snippet, previews[snippet.id])) ?? [],
    [previews, snapshot],
  );
  const provider =
    capability.status === "ONLINE" &&
    accountCanSyncWithConnection(capability.account, capability.connection)
      ? capability.account.storageProvider
      : null;

  return (
    <ProductApp
      appearance={appearance.preference}
      capability={capability}
      error={runtimeError ?? (accessToken.error === null ? null : accessToken.error.message)}
      loading={auth.loading || runtimeLoading}
      snippets={snippets}
      syncStatus={snapshot?.syncStatus ?? null}
      user={user}
      onAppearanceChange={appearance.set}
      onConnectStorage={(storageProvider) =>
        withClient(async ({ client, runtime }) => {
          const url = await runtime.runPromise(client.storage.beginLink(storageProvider));
          window.location.assign(url);
        })
      }
      onSignIn={() => {
        window.location.href = "/api/auth/sign-in";
      }}
      onSignOut={() =>
        (async () => {
          try {
            if (user !== null) {
              const resource = resourceRef.current;
              resourceRef.current = null;
              if (resource !== null) await resource.runtime.dispose();

              const runtimeChannel = new BroadcastChannel(runtimeChannelNameFor(user.id));
              runtimeChannel.postMessage("release");
              runtimeChannel.close();

              await navigator.locks.request(databaseLockNameFor(user.id), async () => {
                await Effect.runPromise(
                  clearClientMetadata(user.id).pipe(
                    Effect.provide(makeSqliteLayer(databaseNameFor(user.id))),
                  ),
                );
              });
            }
          } finally {
            await auth.signOut({ returnTo: "/" });
          }
        })()
      }
      onRefresh={() => {
        const resource = resourceRef.current;
        if (resource === null) {
          setRuntimeAttempt((attempt) => attempt + 1);
          return Promise.resolve();
        }
        return resource.runtime.runPromise(resource.client.refresh);
      }}
      onText={async (text) => {
        if (provider === null) throw new Error("Connect storage before adding snippets.");
        const bytes = new TextEncoder().encode(text);
        if (bytes.byteLength > BUFFERED_CONTENT_MAX_BYTES) {
          throw new Error("Web snippets cannot be larger than 64 MiB.");
        }
        const id = crypto.randomUUID();
        await withClient(({ client, runtime }) =>
          runtime.runPromise(
            client.uploads.upload(
              {
                id,
                fileName: `${id}.txt`,
                byteSize: bytes.byteLength,
                mediaType: "text/plain; charset=utf-8",
                storageProvider: provider,
              },
              {
                read: (offset, byteSize) => Effect.succeed(bytes.slice(offset, offset + byteSize)),
              },
            ),
          ),
        );
      }}
      onFiles={async (files) => {
        if (provider === null) throw new Error("Connect storage before adding snippets.");
        await Promise.all(
          files.map((file) =>
            withClient(({ client, runtime }) =>
              runtime.runPromise(
                client.uploads.upload(
                  {
                    id: crypto.randomUUID(),
                    fileName: file.name,
                    byteSize: file.size,
                    mediaType: file.type || null,
                    storageProvider: provider,
                  },
                  {
                    read: (offset, byteSize) =>
                      Effect.tryPromise(() =>
                        file
                          .slice(offset, offset + byteSize)
                          .arrayBuffer()
                          .then((buffer) => new Uint8Array(buffer)),
                      ),
                  },
                ),
              ),
            ),
          ),
        );
      }}
      onDelete={(snippet) =>
        withClient(({ client, runtime }) =>
          runtime.runPromise(
            snippet.kind === "LOCAL"
              ? client.snippets.dismissFailedUpload(snippet.id)
              : client.snippets.delete(snippet.id),
          ),
        )
      }
      onCopy={async (snippet) => {
        const text = previews[snippet.id];
        if (!isTextSnippetFileName(snippet.fileName)) {
          throw new Error("This snippet is not ready to copy.");
        }
        if (text !== undefined) {
          await navigator.clipboard.writeText(text);
          return;
        }
        ensureBufferable(snippet);
        const content = readRemote(snippet.id).then((bytes) => {
          const decoded = decodeSnippetText(bytes);
          if (decoded === null) throw new Error("This snippet is not valid UTF-8 text.");
          return new Blob([decoded], { type: "text/plain" });
        });
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": content })]);
      }}
      onDownload={downloadRemote}
      onOpenExternal={(url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      }}
    />
  );
}
