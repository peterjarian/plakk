import type { StorageProvider } from "@plakk/shared";
import { DropboxIcon } from "@plakk/ui/icons/DropboxIcon";
import { GoogleDriveIcon } from "@plakk/ui/icons/GoogleDriveIcon";
import { OneDriveIcon } from "@plakk/ui/icons/OneDriveIcon";

export function storageProviderLabel(provider: StorageProvider) {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return "Google Drive";
    case "ONE_DRIVE":
      return "OneDrive";
    case "DROPBOX":
      return "Dropbox";
  }
}

export function StorageProviderIcon({ provider }: { readonly provider: StorageProvider }) {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return <GoogleDriveIcon className="size-5" />;
    case "ONE_DRIVE":
      return <OneDriveIcon className="size-5" />;
    case "DROPBOX":
      return <DropboxIcon className="size-5" />;
  }
}
