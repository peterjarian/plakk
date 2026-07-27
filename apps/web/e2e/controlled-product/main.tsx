import type { StorageProvider, User } from "@plakk/shared";
import { accountCanSync, type AccountStatus, type ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { Button } from "@plakk/ui/components/primitives/button";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { HomeView } from "../../src/product/HomeView.tsx";
import {
  AccountProductLifetime,
  type AccountProductLifetimeShape,
} from "../../src/product/account-product-lifetime.ts";
import { makeBrowserAccountProductMirrorLayer } from "../../src/product/browser-readable-mirror.ts";
import { AccountProductReader } from "../../src/product/product-reader.ts";
import { StorageOnboardingProof } from "./StorageOnboardingProof.tsx";
import {
  WebProviderTransfer,
  WebSnippetUploadRemote,
  WebSnippetUploads,
  type WebSnippetUploadsShape,
} from "../../src/product/snippet-upload.ts";
import { uploadPreparedBrowserContent } from "../../src/product/provider-transfer.ts";
import "../../src/styles.css";

const query = new URLSearchParams(location.search);
const accountId = query.get("account") ?? "controlled-user";
const forceSessionMemory = query.get("force-session-memory") === "true";
const holdBackendRefresh = query.get("hold-backend-refresh") === "true";
const startBackendUnavailable = query.get("backend-unavailable") === "true";
const trialAtExactExpiry = query.get("trial-at-exact-expiry") === "true";
const storageOnboardingMode = query.get("storage-onboarding");

const account: AccountStatus = {
  accessEntitlement: {
    status: trialAtExactExpiry ? "BILLING_RESTRICTED" : "TRIAL_ACTIVE",
    trialEndsAt: DateTime.makeUnsafe("2026-08-10T10:15:30.000Z"),
  },
  canSync: !trialAtExactExpiry,
  storageProvider: "GOOGLE_DRIVE",
  blockedReasons: trialAtExactExpiry ? ["billing"] : [],
};
let controlledAccount = account;

const user: User = {
  id: accountId,
  email: "browser-proof@example.com",
  firstName: "Browser",
  lastName: "Proof",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const snippet = (id: string, fileName: string): ApiSnippet => ({
  id,
  fileName,
  byteSize: 128,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: `object-${id}`,
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
});

let snapshot: ReadonlyArray<ApiSnippet> = [
  snippet("0d1e2f3a-4567-4890-8abc-def012345678", "Initial snapshot.png"),
];
let apiUnavailable = startBackendUnavailable;
let nextBackendReadDelayMillis = 0;
let activeController: ReadableStreamDefaultController<void> | null = null;

const invalidations = Stream.fromReadableStream({
  evaluate: () =>
    new ReadableStream<void>({
      start(controller) {
        activeController = controller;
        controller.enqueue(undefined);
      },
      cancel() {
        activeController = null;
      },
    }),
  onError: (cause) =>
    new RpcError({
      code: "INTERNAL_SERVER_ERROR",
      message: cause instanceof Error ? cause.message : "controlled stream failure",
    }),
});

const readerLayer = Layer.succeed(
  AccountProductReader,
  AccountProductReader.of({
    invalidations,
    read: Effect.suspend(() => {
      if (holdBackendRefresh) return Effect.never;
      if (apiUnavailable) {
        return Effect.fail(
          new RpcError({
            code: "INTERNAL_SERVER_ERROR",
            message: "controlled API outage",
          }),
        );
      }
      const response = { account: controlledAccount, snippets: snapshot };
      if (nextBackendReadDelayMillis === 0) return Effect.succeed(response);
      const delayMillis = nextBackendReadDelayMillis;
      nextBackendReadDelayMillis = 0;
      document.documentElement.dataset.backendReadStarted = "true";
      return Effect.sleep(`${delayMillis} millis`).pipe(Effect.as(response));
    }),
  }),
);
const snippetUploadsLayer = WebSnippetUploads.layer.pipe(
  Layer.provide(
    Layer.merge(
      Layer.succeed(
        WebSnippetUploadRemote,
        WebSnippetUploadRemote.of({
          prepare: (input) =>
            Effect.suspend(() => {
              const prepareCount = Number(document.documentElement.dataset.prepareCount ?? "0") + 1;
              document.documentElement.dataset.prepareCount = String(prepareCount);
              if (!accountCanSync(controlledAccount)) {
                return Effect.fail(
                  new RpcError({
                    code: "FORBIDDEN",
                    message: "Controlled account restriction blocked preparation.",
                  }),
                );
              }
              const mode = input.fileName.toLowerCase().includes("failure")
                ? "failure"
                : input.fileName.toLowerCase().includes("interrupted")
                  ? "interrupt"
                  : input.fileName.toLowerCase().includes("pending")
                    ? "pending"
                    : "success";
              return Effect.succeed({
                storageProvider: input.storageProvider,
                storageObjectId: null,
                upload: {
                  method: "PUT" as const,
                  url: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${input.id}&mode=${mode}`,
                  headers: [
                    { name: "Content-Type", value: input.mediaType ?? "application/octet-stream" },
                  ],
                  strategy:
                    input.byteSize === 0
                      ? {
                          type: "byte_range" as const,
                          maxPartByteSize: 262_144,
                          partByteMultiple: 262_144,
                        }
                      : { type: "single_request" as const },
                },
                expiresAt: null,
              });
            }),
          publish: (input) =>
            Effect.suspend(() => {
              const publishCount = Number(document.documentElement.dataset.publishCount ?? "0") + 1;
              document.documentElement.dataset.publishCount = String(publishCount);
              if (!accountCanSync(controlledAccount)) {
                return Effect.fail(
                  new RpcError({
                    code: "FORBIDDEN",
                    message: "Controlled account restriction blocked publication.",
                  }),
                );
              }
              if (input.fileName.toLowerCase().includes("conflict")) {
                snapshot = [
                  {
                    ...snippet(input.id, input.fileName),
                    storageObjectId: `different-${input.storageObjectId}`,
                  },
                  ...snapshot.filter(({ id }) => id !== input.id),
                ];
                return Effect.fail(
                  new RpcError({
                    code: "CONFLICT",
                    message: "Snippet identifier is already used by different content.",
                  }),
                );
              }
              const published = snippet(input.id, input.fileName);
              const complete = { ...published, ...input };
              snapshot = [complete, ...snapshot.filter(({ id }) => id !== input.id)];
              if (input.fileName.toLowerCase().includes("lost-response")) {
                return Effect.fail(
                  new RpcError({
                    code: "INTERNAL_SERVER_ERROR",
                    message: "Controlled publication response was lost.",
                  }),
                );
              }
              return Effect.succeed(complete);
            }),
        }),
      ),
      Layer.succeed(
        WebProviderTransfer,
        WebProviderTransfer.of({
          upload: (input) => uploadPreparedBrowserContent(input, window.fetch.bind(window)),
        }),
      ),
    ),
  ),
);
let delayNextMirrorWrite: () => void = () => undefined;
const mirrorLayer = makeBrowserAccountProductMirrorLayer(accountId, {
  forceSessionMemory,
  installTestWriteDelay: (setDelay) => {
    delayNextMirrorWrite = () => setDelay(10_000);
  },
  onTestWriteStarted: () => {
    document.documentElement.dataset.mirrorWriteStarted = "true";
  },
});
const runtime = ManagedRuntime.make(
  Layer.merge(
    AccountProductLifetime.layer.pipe(
      Layer.provide(Layer.mergeAll(readerLayer, mirrorLayer, snippetUploadsLayer)),
    ),
    snippetUploadsLayer,
  ),
);
const lifetimePromise = runtime.runPromise(AccountProductLifetime);
const uploadsPromise = runtime.runPromise(WebSnippetUploads);

const invalidate = () => activeController?.enqueue(undefined);

function Controls() {
  return (
    <aside
      aria-label="Controlled transport"
      className="fixed inset-x-3 bottom-3 z-50 grid max-h-[calc(100vh-1.5rem)] grid-cols-4 gap-2 overflow-y-auto rounded-lg border bg-background p-2 shadow"
    >
      <Button
        type="button"
        size="sm"
        onClick={() => {
          snapshot = [snippet("4d1e2f3a-4567-4890-8abc-def012345672", "Stale snapshot.png")];
          nextBackendReadDelayMillis = 3_000;
          invalidate();
        }}
      >
        Start stale delayed refresh
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          snapshot = [snippet("1d1e2f3a-4567-4890-8abc-def012345679", "Replacement snapshot.png")];
          invalidate();
        }}
      >
        Replace snapshot
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          snapshot = [snippet("2d1e2f3a-4567-4890-8abc-def012345670", "After close.png")];
          invalidate();
        }}
      >
        Replace after close
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          delayNextMirrorWrite();
          snapshot = [snippet("3d1e2f3a-4567-4890-8abc-def012345671", "Interrupted candidate.png")];
          invalidate();
        }}
      >
        Start interruptible replacement
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          void lifetimePromise.then((lifetime) => runtime.runPromise(lifetime.clear));
        }}
      >
        Purge account facts
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          apiUnavailable = true;
          invalidate();
        }}
      >
        API outage
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          apiUnavailable = false;
          invalidate();
        }}
      >
        Restore API
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          snapshot = [snippet("2d1e2f3a-4567-4890-8abc-def012345670", "Reconnected snapshot.png")];
          activeController?.close();
          activeController = null;
        }}
      >
        Disconnect stream
      </Button>
      <Button type="button" size="sm" onClick={invalidate}>
        Refresh upload snapshot
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          controlledAccount = {
            ...account,
            accessEntitlement: {
              ...account.accessEntitlement,
              status: "BILLING_RESTRICTED",
            },
            blockedReasons: ["billing"],
            canSync: false,
          };
          invalidate();
        }}
      >
        Restrict billing
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          controlledAccount = {
            ...account,
            blockedReasons: ["storage"],
            canSync: false,
          };
          invalidate();
        }}
      >
        Restrict storage
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          controlledAccount = account;
          invalidate();
        }}
      >
        Restore commands
      </Button>
    </aside>
  );
}

function ActiveProduct(props: {
  readonly lifetime: AccountProductLifetimeShape;
  readonly uploads: WebSnippetUploadsShape;
}) {
  const { lifetime, uploads } = props;
  const state = useSyncExternalStore(
    lifetime.subscribe,
    lifetime.getSnapshot,
    lifetime.getSnapshot,
  );
  const uploadProvider =
    state.kind === "ready" && state.apiAvailability === "available" && accountCanSync(state.account)
      ? state.account.storageProvider
      : null;
  const uploadFile = (
    storageProvider: StorageProvider,
    content: Blob,
    fileName: string | null,
    mediaType: string | null,
  ) => {
    const id = crypto.randomUUID();
    return runtime.runPromise(
      uploads.upload({
        id,
        content,
        fileName: fileName ?? `${id}.txt`,
        mediaType,
        storageProvider,
      }),
    );
  };
  return (
    <>
      <HomeView
        user={user}
        state={state}
        onRetry={() => runtime.runFork(lifetime.retry)}
        onSignOut={() => undefined}
        signOutError={null}
        onAddFiles={(files) => {
          if (uploadProvider === null) return;
          for (const file of files) {
            void uploadFile(uploadProvider, file, file.name, file.type || null);
          }
        }}
        onAddText={(text) => {
          if (uploadProvider === null) return;
          void uploadFile(
            uploadProvider,
            new Blob([text], { type: "text/plain; charset=utf-8" }),
            null,
            "text/plain; charset=utf-8",
          );
        }}
        onDismissUpload={(id) => void runtime.runPromise(uploads.dismiss(id))}
        uploadsDisabled={uploadProvider === null}
      />
      <Controls />
    </>
  );
}

function Product() {
  const [lifetime, setLifetime] = useState<AccountProductLifetimeShape | null>(null);
  const [uploads, setUploads] = useState<WebSnippetUploadsShape | null>(null);
  useEffect(() => {
    let mounted = true;
    void Promise.all([lifetimePromise, uploadsPromise]).then(
      ([productLifetime, snippetUploads]) => {
        if (!mounted) return;
        runtime.runFork(productLifetime.enter(accountId));
        setLifetime(productLifetime);
        setUploads(snippetUploads);
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  return lifetime === null || uploads === null ? (
    <span>Loading controlled product</span>
  ) : (
    <ActiveProduct lifetime={lifetime} uploads={uploads} />
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Controlled product root is missing.");

createRoot(root).render(
  storageOnboardingMode === null ? (
    <Product />
  ) : (
    <StorageOnboardingProof
      mode={storageOnboardingMode as Parameters<typeof StorageOnboardingProof>[0]["mode"]}
    />
  ),
);
