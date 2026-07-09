import type { StorageProvider } from "@plakk/shared";

export const getProviderSlug = (provider: StorageProvider) => {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return "google-drive";
    case "ONE_DRIVE":
      return "microsoft-onedrive";
    case "DROPBOX":
      return "dropbox";
  }
};
