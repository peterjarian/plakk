import { SqliteClient } from "@effect/sql-sqlite-wasm";
import {
  Client,
  type ClientSnapshot,
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

const downloadBytes = (bytes: Uint8Array, fileName: string) => {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));
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
  }, 1_000);
};

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
  presentation: deriveSnippetPresentation({
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
  const resourceRef = useRef<RuntimeResource | null>(null);
  const previewingRef = useRef(new Set<string>());
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const appearance = useAppearance();

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
    const sqliteLayer = SqliteClient.layer({
      worker: Effect.acquireRelease(
        Effect.sync(
          () =>
            new Worker(new URL("./sqlite-worker.ts", import.meta.url), {
              name: `plakk-${user.id}`,
              type: "module",
            }),
        ),
        (worker) => Effect.sync(() => worker.terminate()),
      ),
    });
    const protocolLayer = RpcClient.layerProtocolHttp({ url: rpcUrl }).pipe(
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(RpcSerialization.layerNdjson),
    );
    const runtime = ManagedRuntime.make(
      clientLayer.pipe(Layer.provide(Layer.mergeAll(sessionLayer, sqliteLayer, protocolLayer))),
    );

    void runtime
      .runPromise(
        Effect.gen(function* () {
          const client = yield* Client;
          if (active) resourceRef.current = { client, runtime };
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
      )
      .catch((cause) => {
        if (!active) return;
        setRuntimeLoading(false);
        setRuntimeError(messageFrom(cause, "Plakk could not start in this browser."));
      });

    return () => {
      active = false;
      if (resourceRef.current?.runtime === runtime) resourceRef.current = null;
      void runtime.dispose();
    };
  }, [user?.id]);

  useEffect(() => {
    const resource = resourceRef.current;
    if (resource === null || snapshot === null) return;
    for (const snippet of snapshot.snippets) {
      if (
        snippet.status !== "PUBLISHED" ||
        !isTextSnippetFileName(snippet.fileName) ||
        snippet.byteSize > TEXT_PREVIEW_MAX_BYTES ||
        previews[snippet.id] !== undefined ||
        previewingRef.current.has(snippet.id)
      ) {
        continue;
      }
      previewingRef.current.add(snippet.id);
      void resource.runtime
        .runPromise(collectBytes(resource.client.content.readRemote(snippet.id)))
        .then((bytes) => {
          const preview = decodeSnippetTextPreview(bytes);
          if (preview !== null) setPreviews((current) => ({ ...current, [snippet.id]: preview }));
        })
        .catch(() => {
          // The generic text-snippet presentation remains if a preview cannot be read.
        })
        .finally(() => previewingRef.current.delete(snippet.id));
    }
  }, [previews, snapshot]);

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
      onSignIn={() => {
        window.location.href = "/api/auth/sign-in";
      }}
      onSignOut={() =>
        (async () => {
          const resource = resourceRef.current;
          if (resource !== null) {
            await resource.runtime.runPromise(resource.client.clearLocalData);
          }
          await auth.signOut({ returnTo: "/" });
        })()
      }
      onRefresh={() => withClient(({ client, runtime }) => runtime.runPromise(client.refresh))}
      onText={async (text) => {
        if (provider === null) throw new Error("Connect storage before adding snippets.");
        const bytes = new TextEncoder().encode(text);
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
        for (const file of files) {
          await withClient(({ client, runtime }) =>
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
          );
        }
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
        const bytes = await readRemote(snippet.id);
        const text = decodeSnippetText(bytes);
        if (text !== null && isTextSnippetFileName(snippet.fileName)) {
          await navigator.clipboard.writeText(text);
          return;
        }
        downloadBytes(bytes, snippet.fileName);
      }}
      onDownload={async (snippet) => {
        downloadBytes(await readRemote(snippet.id), snippet.fileName);
      }}
      onOpenExternal={(url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      }}
    />
  );
}
