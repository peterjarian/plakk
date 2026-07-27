import type { StorageProvider } from "@plakk/shared";
import { DropboxIcon } from "@plakk/ui/icons/DropboxIcon";
import { GoogleDriveIcon } from "@plakk/ui/icons/GoogleDriveIcon";
import { OneDriveIcon } from "@plakk/ui/icons/OneDriveIcon";
import type { ComponentType } from "react";

export const storageProviderChoices: ReadonlyArray<{
  readonly provider: StorageProvider;
  readonly label: string;
  readonly Icon: ComponentType<{ readonly className?: string }>;
}> = [
  { provider: "GOOGLE_DRIVE", label: "Google Drive", Icon: GoogleDriveIcon },
  { provider: "ONE_DRIVE", label: "OneDrive", Icon: OneDriveIcon },
  { provider: "DROPBOX", label: "Dropbox", Icon: DropboxIcon },
];

const storageProviderLabels = Object.fromEntries(
  storageProviderChoices.map(({ label, provider }) => [provider, label]),
) as Record<StorageProvider, string>;

export const storageProviderLabel = (provider: StorageProvider): string =>
  storageProviderLabels[provider];
