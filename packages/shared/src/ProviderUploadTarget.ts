import type { StorageProvider } from "./StorageProvider.ts";

const isOneDriveUploadHost = (hostname: string) =>
  hostname.endsWith(".up.1drv.com") && hostname !== ".up.1drv.com";

export const isSupportedProviderUploadTarget = (
  storageProvider: StorageProvider,
  rawUrl: string,
): boolean => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;

  switch (storageProvider) {
    case "GOOGLE_DRIVE":
      return url.hostname === "www.googleapis.com";
    case "ONE_DRIVE":
      return isOneDriveUploadHost(url.hostname);
    case "DROPBOX":
      return url.hostname === "content.dropboxapi.com";
  }
};
