import type { StorageProvider, User } from "@plakk/shared";
import { accountCanSync } from "@plakk/shared/PlakkApi";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useState } from "react";

import { HomeView } from "./HomeView.tsx";
import { AccountProductMirrorError } from "./readable-mirror.ts";
import { accountNeedsStorageOnboarding } from "./storage-onboarding.ts";
import { useWebProduct } from "./web-product-context.tsx";

export function AuthenticatedHome(props: {
  readonly onBilling: () => void;
  readonly onSettings: () => void;
  readonly onStorageOnboardingRequired: () => void;
  readonly user: User;
}) {
  const { onBilling, onSettings, onStorageOnboardingRequired, user } = props;
  const product = useWebProduct();
  const upload = useCallback(
    (
      storageProvider: StorageProvider,
      content: Blob,
      fileName: string | null,
      mediaType: string | null,
    ) => {
      if (product.snippetUploads === null) return;
      const id = crypto.randomUUID();
      void product.snippetUploads.upload({
        id,
        content,
        fileName: fileName ?? `${id}.txt`,
        mediaType,
        storageProvider,
      });
    },
    [product.snippetUploads],
  );
  const [signOutError, setSignOutError] = useState<"product-purge" | "workos" | null>(null);
  const handleSignOut = useCallback(async () => {
    if (product.signOut === null) return;
    setSignOutError(null);
    try {
      await product.signOut();
    } catch (cause) {
      setSignOutError(Schema.is(AccountProductMirrorError)(cause) ? "product-purge" : "workos");
    }
  }, [product.signOut]);

  const storageOnboardingRequired =
    product.state.kind === "ready" &&
    product.state.apiAvailability === "available" &&
    accountNeedsStorageOnboarding(product.state.account) &&
    !product.state.snippets.some((record) => record.kind === "PUBLISHED");
  const uploadProvider =
    product.state.kind === "ready" &&
    product.state.apiAvailability === "available" &&
    accountCanSync(product.state.account)
      ? product.state.account.storageProvider
      : null;
  useEffect(() => {
    if (storageOnboardingRequired) {
      onStorageOnboardingRequired();
    }
  }, [onStorageOnboardingRequired, storageOnboardingRequired]);
  if (storageOnboardingRequired) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Opening storage setup
      </main>
    );
  }
  return (
    <HomeView
      user={user}
      state={product.state}
      onRetry={product.retry}
      onSignOut={() => void handleSignOut()}
      signOutError={signOutError}
      onAddFiles={(files) => {
        if (uploadProvider === null) return;
        for (const file of files) {
          upload(uploadProvider, file, file.name, file.type || null);
        }
      }}
      onAddText={(text) => {
        if (uploadProvider === null) return;
        upload(
          uploadProvider,
          new Blob([text], { type: "text/plain; charset=utf-8" }),
          null,
          "text/plain; charset=utf-8",
        );
      }}
      onDismissUpload={(id) => void product.snippetUploads?.dismiss(id)}
      onBilling={onBilling}
      onSettings={onSettings}
      onStorageReconnect={onStorageOnboardingRequired}
      snippetActions={product.snippetActions}
      uploadsDisabled={uploadProvider === null || product.snippetUploads === null}
    />
  );
}
