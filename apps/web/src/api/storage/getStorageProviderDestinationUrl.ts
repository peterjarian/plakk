import type { StorageProvider } from "@plakk/shared";

export const getStorageProviderDestinationUrl = (provider: StorageProvider) => {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return "https://drive.google.com/drive/my-drive";
    case "ONE_DRIVE":
      return "https://onedrive.live.com/";
    case "DROPBOX":
      return "https://www.dropbox.com/home";
  }
};
