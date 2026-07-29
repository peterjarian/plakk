import type { StorageProvider } from "@plakk/shared";
import { DropboxIcon } from "@plakk/ui/icons/DropboxIcon";
import { GoogleDriveIcon } from "@plakk/ui/icons/GoogleDriveIcon";
import { OneDriveIcon } from "@plakk/ui/icons/OneDriveIcon";
import type { ComponentProps } from "react";

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

export function StorageProviderIcon({
  provider,
  ...props
}: { readonly provider: StorageProvider } & ComponentProps<"svg">) {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return <GoogleDriveIcon {...props} />;
    case "ONE_DRIVE":
      return <OneDriveIcon {...props} />;
    case "DROPBOX":
      return <DropboxIcon {...props} />;
  }
}
