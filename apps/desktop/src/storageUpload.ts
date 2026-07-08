import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { PreparedStorageUpload } from "@plakk/shared/PlakkApi";

export type PreparedFileUploadPayload = {
  readonly prepared: PreparedStorageUpload;
  readonly filePath: string;
  readonly byteSize: number;
};

export type RendererPreparedFileUploadPayload = Omit<PreparedFileUploadPayload, "filePath"> & {
  readonly file: File;
};

export const makeByteRanges = (
  byteSize: number,
  maxPartByteSize: number,
): ReadonlyArray<{ readonly start: number; readonly end: number }> => {
  if (byteSize <= 0) return [];

  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  for (let start = 0; start < byteSize; start += maxPartByteSize) {
    ranges.push({ start, end: Math.min(start + maxPartByteSize, byteSize) - 1 });
  }
  return ranges;
};

export const uploadPartByteSize = (maxPartByteSize: number, partByteMultiple: number) =>
  Math.floor(maxPartByteSize / partByteMultiple) * partByteMultiple;

async function uploadPart(
  upload: PreparedStorageUpload["upload"],
  filePath: string,
  range: { readonly start: number; readonly end: number } | null,
  headers: HeadersInit,
) {
  const response = await fetch(upload.url, {
    method: upload.method,
    headers,
    body: createReadStream(filePath, range ?? undefined) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Upload failed: ${response.status}${body ? ` ${body}` : ""}`);
  }
}

async function assertUploadFile(filePath: string, byteSize: number) {
  const stats = await stat(filePath);
  if (!stats.isFile()) throw new Error("Upload source is not a file.");
  if (stats.size !== byteSize) {
    throw new Error("Upload source size changed before upload.");
  }
}

export async function uploadPreparedFile(payload: PreparedFileUploadPayload) {
  await assertUploadFile(payload.filePath, payload.byteSize);

  const uploadHeaders = Object.fromEntries(
    payload.prepared.upload.headers.map((header) => [header.name, header.value]),
  );

  if (payload.prepared.upload.strategy.type === "single_request") {
    await uploadPart(payload.prepared.upload, payload.filePath, null, {
      ...uploadHeaders,
      "Content-Length": String(payload.byteSize),
    });
    return;
  }

  const partByteSize = uploadPartByteSize(
    payload.prepared.upload.strategy.maxPartByteSize,
    payload.prepared.upload.strategy.partByteMultiple,
  );
  if (partByteSize < 1) throw new Error("Upload part size is invalid.");

  for (const range of makeByteRanges(payload.byteSize, partByteSize)) {
    await uploadPart(payload.prepared.upload, payload.filePath, range, {
      ...uploadHeaders,
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${payload.byteSize}`,
    });
  }
}
