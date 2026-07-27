import type { StorageProvider } from "./StorageProvider.ts";

export const isTrustedStorageDownloadUrl = (
  storageProvider: StorageProvider,
  value: string,
): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (storageProvider === "GOOGLE_DRIVE") {
      return (
        url.hostname === "www.googleapis.com" ||
        url.hostname === "drive.google.com" ||
        url.hostname === "drive.usercontent.google.com" ||
        url.hostname.endsWith(".googleusercontent.com")
      );
    }
    if (storageProvider === "ONE_DRIVE") {
      return url.hostname.endsWith(".1drv.com") || url.hostname.endsWith(".sharepoint.com");
    }
    return url.hostname.endsWith(".dropboxusercontent.com");
  } catch {
    return false;
  }
};
