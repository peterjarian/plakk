// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { downloadFile } from "./browserDownloads.ts";

describe("browser downloads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("releases the temporary file and lock without waiting to revoke the object URL", async () => {
    const writable = {
      abort: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
      write: vi.fn(() => Promise.resolve()),
    };
    const removeEntry = vi.fn(() => Promise.resolve());
    const directory = {
      getFileHandle: vi.fn(() =>
        Promise.resolve({
          createWritable: () => Promise.resolve(writable),
          getFile: () => Promise.resolve(new File(["snippet"], "temporary")),
        }),
      ),
      removeEntry,
    };
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        getDirectory: () =>
          Promise.resolve({
            getDirectoryHandle: () => Promise.resolve(directory),
          }),
      },
    });
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, callback: (lock: object) => Promise<unknown>) => callback({}),
      },
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await downloadFile("note.txt", async (write) => write(Uint8Array.from([1, 2, 3])));

    expect(removeEntry).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });
});
