import { isSupportedProviderUploadTarget } from "./ProviderUploadTarget.ts";
import { describe, expect, it } from "vite-plus/test";

describe("provider upload target boundary", () => {
  it.each([
    ["GOOGLE_DRIVE", "https://www.googleapis.com/upload/drive/v3/files?upload_id=secret"],
    ["ONE_DRIVE", "https://sn3302.up.1drv.com/up/opaque-session"],
    ["DROPBOX", "https://content.dropboxapi.com/apitul/1/opaque-session"],
  ] as const)("accepts the documented HTTPS target for %s", (provider, url) => {
    expect(isSupportedProviderUploadTarget(provider, url)).toBe(true);
  });

  it.each([
    ["GOOGLE_DRIVE", "http://www.googleapis.com/upload/drive/v3/files"],
    ["GOOGLE_DRIVE", "https://www.googleapis.com.evil.example/upload"],
    ["ONE_DRIVE", "https://up.1drv.com.evil.example/up/session"],
    ["DROPBOX", "https://content.dropboxapi.com.evil.example/upload"],
    ["DROPBOX", "javascript:alert(1)"],
  ] as const)("rejects unsupported or ambiguous targets for %s", (provider, url) => {
    expect(isSupportedProviderUploadTarget(provider, url)).toBe(false);
  });
});
