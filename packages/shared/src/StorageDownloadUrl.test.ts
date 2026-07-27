import { describe, expect, it } from "vite-plus/test";

import { isTrustedStorageDownloadUrl } from "./StorageDownloadUrl.ts";

describe("trusted storage download URLs", () => {
  it.each([
    ["GOOGLE_DRIVE", "https://drive.usercontent.google.com/download/id"],
    ["ONE_DRIVE", "https://tenant.sharepoint.com/download/id"],
    ["DROPBOX", "https://content.dropboxusercontent.com/download/id"],
  ] as const)("accepts the authoritative %s download host", (provider, url) => {
    expect(isTrustedStorageDownloadUrl(provider, url)).toBe(true);
  });

  it.each([
    ["GOOGLE_DRIVE", "http://drive.usercontent.google.com/download/id"],
    ["GOOGLE_DRIVE", "https://attacker.example/download/id"],
    ["ONE_DRIVE", "not a URL"],
  ] as const)("rejects an untrusted %s download URL", (provider, url) => {
    expect(isTrustedStorageDownloadUrl(provider, url)).toBe(false);
  });
});
