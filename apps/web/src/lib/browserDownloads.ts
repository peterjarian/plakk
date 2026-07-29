const downloadLockNameFor = (temporaryName: string) => `plakk:download:${temporaryName}`;

const startDownload = (blob: Blob, fileName: string, onRevoke: () => void) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.hidden = true;
  anchor.href = url;
  anchor.download = fileName.split(/[\\/]/).filter(Boolean).pop() ?? "snippet";
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
    onRevoke();
  }, 60_000);
};

export async function sweepTemporaryDownloads() {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("plakk-downloads", { create: true });
  for await (const temporaryName of directory.keys()) {
    await navigator.locks.request(
      downloadLockNameFor(temporaryName),
      { ifAvailable: true },
      async (lock) => {
        if (lock !== null) await directory.removeEntry(temporaryName).catch(() => {});
      },
    );
  }
}

export async function downloadFile(
  fileName: string,
  stream: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("plakk-downloads", { create: true });
  const temporaryName = crypto.randomUUID();
  await navigator.locks.request(downloadLockNameFor(temporaryName), async () => {
    const handle = await directory.getFileHandle(temporaryName, { create: true });
    const writable = await handle.createWritable();
    try {
      await stream((chunk) => writable.write(Uint8Array.from(chunk)));
      await writable.close();
      const file = await handle.getFile();
      await new Promise<void>((resolve) => startDownload(file, fileName, resolve));
      await directory.removeEntry(temporaryName).catch(() => {});
    } catch (cause) {
      await writable.abort().catch(() => {});
      await directory.removeEntry(temporaryName).catch(() => {});
      throw cause;
    }
  });
}
