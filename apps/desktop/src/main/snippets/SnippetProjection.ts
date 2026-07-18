import {
  decodeSnippetTextPreview,
  isTextSnippetFileName,
  SNIPPET_TEXT_PREVIEW_MAX_BYTES,
} from "@plakk/shared";
import type { LocalContentAvailability } from "@plakk/shared";
import { Effect } from "effect";

import { ManagedSnippetContent } from "./content/ManagedSnippetContent.ts";
import type { UploadProjectedSnippet } from "./upload/SnippetUploadEngine.ts";

export const projectDesktopManagedContent = Effect.fn(
  "DesktopSnippetProjection.projectManagedContent",
)(function* (
  accountId: string,
  snippet: UploadProjectedSnippet,
  localContentAvailability: LocalContentAvailability,
) {
  const { importingContent, ...metadata } = snippet;
  if (importingContent !== undefined) return { ...metadata, ...importingContent };
  if (localContentAvailability.status !== "AVAILABLE") {
    return { ...metadata, localTextPreview: null, localContentAvailability };
  }
  if (!isTextSnippetFileName(metadata.fileName)) {
    return { ...metadata, localTextPreview: null, localContentAvailability };
  }

  const content = yield* ManagedSnippetContent;
  const contentResult = yield* content
    .getPrefix(accountId, metadata.id, SNIPPET_TEXT_PREVIEW_MAX_BYTES)
    .pipe(
      Effect.match({
        onFailure: (error) => ({ error }) as const,
        onSuccess: (bytes) => ({ bytes }) as const,
      }),
    );
  if ("error" in contentResult) {
    return {
      ...metadata,
      localTextPreview: null,
      localContentAvailability: {
        status: "FAILED",
        message: contentResult.error.reason,
      } as const,
    };
  }
  const { bytes } = contentResult;
  const previewByteSize = Math.min(metadata.byteSize, SNIPPET_TEXT_PREVIEW_MAX_BYTES);
  if (bytes === null || bytes.byteLength !== previewByteSize) {
    return {
      ...metadata,
      localTextPreview: null,
      localContentAvailability: { status: "NOT_AVAILABLE" } as const,
    };
  }

  const validation = yield* content
    .validateText(accountId, metadata.id)
    .pipe(
      Effect.catch((error) => Effect.succeed({ status: "ERROR" as const, message: error.reason })),
    );
  if (typeof validation !== "string") {
    return {
      ...metadata,
      localTextPreview: null,
      localContentAvailability: { status: "FAILED", message: validation.message } as const,
    };
  }
  if (validation === "NOT_FOUND") {
    return {
      ...metadata,
      localTextPreview: null,
      localContentAvailability: { status: "NOT_AVAILABLE" } as const,
    };
  }
  if (validation === "INVALID") {
    return { ...metadata, localTextPreview: null, localContentAvailability };
  }

  const localTextPreview = decodeSnippetTextPreview(bytes, metadata.byteSize > bytes.byteLength);
  return localTextPreview === null
    ? {
        ...metadata,
        localTextPreview: null,
        localContentAvailability,
      }
    : {
        ...metadata,
        localTextPreview,
        localContentAvailability,
      };
});
