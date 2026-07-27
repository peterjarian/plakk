import type { StorageProvider } from "@plakk/shared";
import type {
  StorageCleanupAction,
  StorageCleanupRunResult,
  StorageManagementState,
} from "@plakk/shared/PlakkApi";
import { Button } from "@plakk/ui/components/primitives/button";
import { useCallback, useEffect, useMemo, useState } from "react";

import { StorageManagementView } from "../../src/product/StorageManagementView.tsx";

type StorageManagementMode = "connected" | "partial" | "reauthorization";

type ControlledAuthority = {
  readonly linkedProvider: StorageProvider | null;
  readonly snapshot: StorageManagementState;
};

const storageKey = (session: string) => `plakk-storage-management:${session}`;

const initialAuthority = (mode: StorageManagementMode): ControlledAuthority => ({
  linkedProvider: "GOOGLE_DRIVE",
  snapshot: {
    affectedSnippetCount: 3,
    cleanup:
      mode === "partial"
        ? {
            action: "SWITCH",
            lastFailure: "Controlled provider deletion failed. Retry cleanup.",
            remainingSnippetCount: 2,
            totalSnippetCount: 3,
          }
        : null,
    connectionStatus: mode === "reauthorization" ? "NEEDS_REAUTHORIZATION" : "CONNECTED",
    externalDestinationUrl: mode === "reauthorization" ? null : "https://drive.example/folder",
    storageProvider: "GOOGLE_DRIVE",
  },
});

const parseAuthority = (value: string | null, mode: StorageManagementMode): ControlledAuthority => {
  if (value === null) return initialAuthority(mode);
  try {
    return JSON.parse(value) as ControlledAuthority;
  } catch {
    return initialAuthority(mode);
  }
};

export function StorageManagementProof(props: {
  readonly mode: StorageManagementMode;
  readonly session: string;
}) {
  const key = useMemo(() => storageKey(props.session), [props.session]);
  const [revision, setRevision] = useState(0);
  const [completedAction, setCompletedAction] = useState<StorageCleanupAction | null>(null);
  const [redirectedProvider, setRedirectedProvider] = useState<StorageProvider | null>(null);
  const [lateCommand, setLateCommand] = useState<"idle" | "rejected">("idle");

  const readAuthority = useCallback(
    () => parseAuthority(localStorage.getItem(key), props.mode),
    [key, props.mode],
  );
  const writeAuthority = useCallback(
    (authority: ControlledAuthority) => {
      localStorage.setItem(key, JSON.stringify(authority));
      setRevision((value) => value + 1);
    },
    [key],
  );

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) setRevision((value) => value + 1);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);

  const read = useCallback(async () => readAuthority().snapshot, [readAuthority]);
  const beginCleanup = useCallback(
    async (
      action: StorageCleanupAction,
      storageProvider: StorageProvider,
      expectedSnippetCount: number,
    ): Promise<StorageCleanupRunResult> => {
      const authority = readAuthority();
      if (
        authority.linkedProvider !== storageProvider ||
        authority.snapshot.affectedSnippetCount !== expectedSnippetCount
      ) {
        throw new Error("Controlled authoritative state changed.");
      }
      if (props.mode === "partial") {
        const progress = {
          action,
          lastFailure: "Controlled provider deletion failed. Retry cleanup.",
          remainingSnippetCount: 2,
          totalSnippetCount: expectedSnippetCount,
        } as const;
        writeAuthority({
          linkedProvider: storageProvider,
          snapshot: {
            ...authority.snapshot,
            affectedSnippetCount: expectedSnippetCount,
            cleanup: progress,
          },
        });
        return { outcome: "PARTIAL", progress };
      }
      writeAuthority({
        linkedProvider: null,
        snapshot: {
          affectedSnippetCount: 0,
          cleanup: null,
          connectionStatus: "NOT_CONNECTED",
          externalDestinationUrl: null,
          storageProvider: null,
        },
      });
      return { action, outcome: "COMPLETED" };
    },
    [props.mode, readAuthority, writeAuthority],
  );

  const retryCleanup = useCallback(
    async (storageProvider: StorageProvider): Promise<StorageCleanupRunResult> => {
      const authority = readAuthority();
      const action = authority.snapshot.cleanup?.action;
      if (authority.linkedProvider !== storageProvider || action === undefined) {
        throw new Error("No controlled cleanup is available.");
      }
      const remainingSnippetCount = (authority.snapshot.cleanup?.remainingSnippetCount ?? 0) - 1;
      if (remainingSnippetCount > 0) {
        const progress = {
          action,
          lastFailure: "Controlled provider deletion failed again. Retry cleanup.",
          remainingSnippetCount,
          totalSnippetCount: authority.snapshot.cleanup?.totalSnippetCount ?? 0,
        };
        writeAuthority({
          linkedProvider: storageProvider,
          snapshot: {
            ...authority.snapshot,
            cleanup: progress,
          },
        });
        return { outcome: "PARTIAL", progress };
      }
      writeAuthority({
        linkedProvider: null,
        snapshot: {
          affectedSnippetCount: 0,
          cleanup: null,
          connectionStatus: "NOT_CONNECTED",
          externalDestinationUrl: null,
          storageProvider: null,
        },
      });
      return { action, outcome: "COMPLETED" };
    },
    [readAuthority, writeAuthority],
  );

  const reauthorize = useCallback(
    async (storageProvider: StorageProvider) => {
      const authority = readAuthority();
      if (authority.linkedProvider !== storageProvider) {
        throw new Error("A different provider cannot be authorized while one is linked.");
      }
      return { url: `https://api.workos.com/reauthorize/${storageProvider}` };
    },
    [readAuthority],
  );

  if (completedAction !== null) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <section className="grid max-w-lg gap-3 text-center">
          <h1 className="text-2xl font-semibold">
            {completedAction === "SWITCH"
              ? "Choose replacement storage"
              : "Choose a storage provider"}
          </h1>
          <p>Google Drive cleanup completed before provider choice became available.</p>
          <div className="flex justify-center gap-2">
            <Button type="button">Google Drive</Button>
            <Button type="button">OneDrive</Button>
            <Button type="button">Dropbox</Button>
          </div>
        </section>
      </main>
    );
  }

  const authority = readAuthority();
  const cleanupActive = authority.snapshot.cleanup !== null;
  const providerActionUnavailable =
    cleanupActive || authority.snapshot.connectionStatus !== "CONNECTED";

  return (
    <>
      <StorageManagementView
        key={revision}
        beginCleanup={beginCleanup}
        onCompleted={setCompletedAction}
        onRedirect={() => setRedirectedProvider(authority.linkedProvider)}
        read={read}
        reauthorize={reauthorize}
        retryCleanup={retryCleanup}
      />
      <aside className="fixed right-4 bottom-4 grid gap-2 rounded-lg border bg-background p-3 text-sm">
        <Button type="button" disabled={providerActionUnavailable}>
          Provider-dependent action
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (readAuthority().snapshot.cleanup !== null) setLateCommand("rejected");
          }}
        >
          Attempt late command
        </Button>
        {lateCommand === "rejected" && <output>Late command rejected during cleanup</output>}
        {redirectedProvider !== null && (
          <output>Reauthorization requested for {redirectedProvider}</output>
        )}
      </aside>
    </>
  );
}
