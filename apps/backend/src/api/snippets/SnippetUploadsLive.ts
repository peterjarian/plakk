import { and, Drizzle, eq, isNull } from "@plakk/db";
import { snippets, type SnippetRow } from "@plakk/db/schema";
import type { PrepareSnippetUploadPayload, PublishSnippetPayload } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { DateTime, Effect, Layer } from "effect";

import { StorageProviderService } from "../storage/StorageProvider.ts";
import { mapStorageErrorsToRpc } from "../storage/mapStorageErrorsToRpc.ts";
import { toApiSnippet } from "../transformers/toApiSnippet.ts";
import { notifySnippetChanges } from "./snippetInvalidations.ts";
import { SnippetUploads } from "./SnippetUploads.ts";

const conflict = () =>
  new RpcError({
    code: "CONFLICT",
    message: "Snippet identifier is already used by different content.",
  });

const samePublication = (snippet: SnippetRow, input: PublishSnippetPayload) =>
  snippet.id === input.id &&
  snippet.fileName === input.fileName &&
  snippet.byteSize === input.byteSize &&
  snippet.storageProvider === input.storageProvider &&
  snippet.storageObjectId === input.storageObjectId;

export const SnippetUploadsLive = Layer.effect(
  SnippetUploads,
  Effect.gen(function* () {
    const drizzle = yield* Drizzle;
    const storage = yield* StorageProviderService;

    const prepare = Effect.fn("SnippetUploads.prepare")(function* (
      ownerWorkosUserId: string,
      input: PrepareSnippetUploadPayload,
    ) {
      return yield* storage
        .prepareUpload({
          snippetId: input.id,
          storageProvider: input.storageProvider,
          fileName: input.fileName,
          byteSize: input.byteSize,
          contentType: input.mediaType,
          workosUserId: ownerWorkosUserId,
        })
        .pipe(mapStorageErrorsToRpc);
    });

    const publish = Effect.fn("SnippetUploads.publish")(function* (
      ownerWorkosUserId: string,
      input: PublishSnippetPayload,
    ) {
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const result = yield* drizzle.db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [inserted] = yield* tx
              .insert(snippets)
              .values({
                ...input,
                ownerWorkosUserId,
                deletedAt: null,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoNothing()
              .returning();
            if (inserted !== undefined) {
              yield* notifySnippetChanges(tx, ownerWorkosUserId);
              return { type: "snippet" as const, snippet: inserted };
            }

            const [existing] = yield* tx
              .select()
              .from(snippets)
              .where(
                and(
                  eq(snippets.id, input.id),
                  eq(snippets.ownerWorkosUserId, ownerWorkosUserId),
                  isNull(snippets.deletedAt),
                ),
              )
              .limit(1);
            if (existing === undefined || !samePublication(existing, input)) {
              return { type: "conflict" as const };
            }
            return { type: "snippet" as const, snippet: existing };
          }),
        )
        .pipe(Effect.orDie);
      if (result.type === "conflict") return yield* conflict();
      return toApiSnippet(result.snippet);
    });

    return SnippetUploads.of({ prepare, publish });
  }),
);
