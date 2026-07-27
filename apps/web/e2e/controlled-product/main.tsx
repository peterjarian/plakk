import type { User } from "@plakk/shared";
import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { Button } from "@plakk/ui/components/primitives/button";
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
import "../../src/styles.css";

const query = new URLSearchParams(location.search);
const accountId = query.get("account") ?? "controlled-user";
const forceSessionMemory = query.get("force-session-memory") === "true";
const holdBackendRefresh = query.get("hold-backend-refresh") === "true";
const startBackendUnavailable = query.get("backend-unavailable") === "true";

const account: AccountStatus = {
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
  blockedReasons: [],
};

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
      const response = { account, snippets: snapshot };
      if (nextBackendReadDelayMillis === 0) return Effect.succeed(response);
      const delayMillis = nextBackendReadDelayMillis;
      nextBackendReadDelayMillis = 0;
      document.documentElement.dataset.backendReadStarted = "true";
      return Effect.sleep(`${delayMillis} millis`).pipe(Effect.as(response));
    }),
  }),
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
  AccountProductLifetime.layer.pipe(Layer.provide(Layer.merge(readerLayer, mirrorLayer))),
);
const lifetimePromise = runtime.runPromise(AccountProductLifetime);

const invalidate = () => activeController?.enqueue(undefined);

function Controls() {
  return (
    <aside
      aria-label="Controlled transport"
      className="fixed right-3 bottom-3 z-50 flex gap-2 rounded-lg border bg-background p-2 shadow"
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
    </aside>
  );
}

function ActiveProduct({ lifetime }: { readonly lifetime: AccountProductLifetimeShape }) {
  const state = useSyncExternalStore(
    lifetime.subscribe,
    lifetime.getSnapshot,
    lifetime.getSnapshot,
  );
  return (
    <>
      <HomeView
        user={user}
        state={state}
        onRetry={() => runtime.runFork(lifetime.retry)}
        onSignOut={() => undefined}
        signOutError={null}
      />
      <Controls />
    </>
  );
}

function Product() {
  const [lifetime, setLifetime] = useState<AccountProductLifetimeShape | null>(null);
  useEffect(() => {
    let mounted = true;
    void lifetimePromise.then((productLifetime) => {
      if (!mounted) return;
      runtime.runFork(productLifetime.enter(accountId));
      setLifetime(productLifetime);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return lifetime === null ? (
    <span>Loading controlled product</span>
  ) : (
    <ActiveProduct lifetime={lifetime} />
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Controlled product root is missing.");

createRoot(root).render(<Product />);
