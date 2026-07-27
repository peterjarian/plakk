import type { StorageProvider } from "@plakk/shared";
import { DropboxIcon } from "@plakk/ui/icons/DropboxIcon";
import { GoogleDriveIcon } from "@plakk/ui/icons/GoogleDriveIcon";
import { OneDriveIcon } from "@plakk/ui/icons/OneDriveIcon";
import type { ComponentType } from "react";

type StorageProviderPresentation = {
  readonly label: string;
  readonly Icon: ComponentType<{ readonly className?: string }>;
};

const storageProviderCatalog = {
  DROPBOX: { label: "Dropbox", Icon: DropboxIcon },
  GOOGLE_DRIVE: { label: "Google Drive", Icon: GoogleDriveIcon },
  ONE_DRIVE: { label: "OneDrive", Icon: OneDriveIcon },
} satisfies Record<StorageProvider, StorageProviderPresentation>;

export const storageProviderChoices = (
  ["GOOGLE_DRIVE", "ONE_DRIVE", "DROPBOX"] as const satisfies ReadonlyArray<StorageProvider>
).map((provider) => ({ provider, ...storageProviderCatalog[provider] }));

export const storageProviderLabel = (provider: StorageProvider): string =>
  storageProviderCatalog[provider].label;
