import type { StorageProvider } from "@plakk/shared";
import type { ComponentProps } from "react";

import { DropboxIcon } from "../icons/DropboxIcon.tsx";
import { GoogleDriveIcon } from "../icons/GoogleDriveIcon.tsx";
import { OneDriveIcon } from "../icons/OneDriveIcon.tsx";

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
