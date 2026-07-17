import { decodeSnippetText, isTextSnippetFileName } from "@plakk/shared";
import type { LocalContentAvailability } from "@plakk/shared/SnippetHydration";
import { ManagedSnippetContent } from "@plakk/shared/SnippetReplica";
import { Effect } from "effect";

import type { UploadProjectedSnippet } from "./SnippetUploadEngine.ts";

const invalidTextContentMessage = "This text file is not valid UTF-8. Download it again.";

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
    return { ...metadata, localTextContent: null, localContentAvailability };
  }
  if (!isTextSnippetFileName(metadata.fileName)) {
    return { ...metadata, localTextContent: null, localContentAvailability };
  }

  const content = yield* ManagedSnippetContent;
  const contentResult = yield* content.get(accountId, metadata.id).pipe(
    Effect.match({
      onFailure: (error) => ({ error }) as const,
      onSuccess: (bytes) => ({ bytes }) as const,
    }),
  );
  if ("error" in contentResult) {
    return {
      ...metadata,
      localTextContent: null,
      localContentAvailability: {
        status: "FAILED",
        message: contentResult.error.reason,
      } as const,
    };
  }
  const { bytes } = contentResult;
  if (bytes === null || bytes.byteLength !== metadata.byteSize) {
    return {
      ...metadata,
      localTextContent: null,
      localContentAvailability: { status: "NOT_AVAILABLE" } as const,
    };
  }

  const localTextContent = decodeSnippetText(bytes);
  return localTextContent === null
    ? {
        ...metadata,
        localTextContent: null,
        localContentAvailability: { status: "FAILED", message: invalidTextContentMessage } as const,
      }
    : {
        ...metadata,
        localTextContent,
        localContentAvailability,
      };
});
