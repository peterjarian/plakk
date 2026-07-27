import {
  deviceSnippetRecordId,
  orderDeviceSnippetRecords,
  reconcileDeviceSnippetRecords,
  type DeviceSnippetRecord,
  type LocalUploadRecord,
  type StorageProvider,
} from "@plakk/shared";
import type {
  ApiSnippet,
  PreparedStorageUpload,
  PrepareSnippetUploadPayload,
  PublishSnippetPayload,
} from "@plakk/shared/PlakkApi";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { AccountProductReadError } from "./product-reader.ts";
import type { BrowserUploadFetch, WebProviderTransferError } from "./provider-transfer.ts";
import { browserUploadFetch, uploadPreparedBrowserContent } from "./provider-transfer.ts";

export type WebSnippetUploadInput = {
  readonly id: string;
  readonly fileName: string;
  readonly mediaType: string | null;
  readonly storageProvider: StorageProvider;
  readonly content: Blob;
};

export class WebSnippetUploadError extends Schema.TaggedErrorClass<WebSnippetUploadError>()(
  "WebSnippetUploadError",
  { message: Schema.String },
) {}

export class WebSnippetUploadRemote extends Context.Service<
  WebSnippetUploadRemote,
  {
    readonly prepare: (
      input: PrepareSnippetUploadPayload,
    ) => Effect.Effect<PreparedStorageUpload, AccountProductReadError>;
    readonly publish: (
      input: PublishSnippetPayload,
    ) => Effect.Effect<ApiSnippet, AccountProductReadError>;
  }
>()("@plakk/web/product/snippet-upload/WebSnippetUploadRemote") {}

export class WebProviderTransfer extends Context.Service<
  WebProviderTransfer,
  {
    readonly upload: (input: {
      readonly content: Blob;
      readonly prepared: PreparedStorageUpload;
    }) => Effect.Effect<{ readonly storageObjectId: string }, WebProviderTransferError>;
  }
>()("@plakk/web/product/snippet-upload/WebProviderTransfer") {}

export const makeWebProviderTransferLayer = (
  uploadFetch: BrowserUploadFetch = browserUploadFetch,
): Layer.Layer<WebProviderTransfer> =>
  Layer.succeed(
    WebProviderTransfer,
    WebProviderTransfer.of({
      upload: (input) => uploadPreparedBrowserContent(input, uploadFetch),
    }),
  );

export interface WebSnippetUploadsShape {
  readonly clear: Effect.Effect<void>;
  readonly dismiss: (id: string) => Effect.Effect<void>;
  readonly getSnapshot: () => ReadonlyArray<DeviceSnippetRecord>;
  readonly replacePublished: (snippets: ReadonlyArray<ApiSnippet>) => Effect.Effect<void>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly upload: (input: WebSnippetUploadInput) => Effect.Effect<void>;
}

const failureMessage = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "message" in cause &&
  typeof cause.message === "string" &&
  cause.message !== ""
    ? cause.message
    : "This content could not be uploaded. Dismiss it and add the content again.";

const interruptedMessage = "This upload was interrupted. Dismiss it and add the content again.";

export class WebSnippetUploads extends Context.Service<WebSnippetUploads, WebSnippetUploadsShape>()(
  "@plakk/web/product/snippet-upload/WebSnippetUploads",
) {
  static readonly layer = Layer.effect(
    WebSnippetUploads,
    Effect.gen(function* () {
      const remote = yield* WebSnippetUploadRemote;
      const transfer = yield* WebProviderTransfer;
      let records: ReadonlyArray<DeviceSnippetRecord> = [];
      const listeners = new Set<() => void>();

      const publish = (next: ReadonlyArray<DeviceSnippetRecord>) => {
        records = next;
        for (const listener of listeners) listener();
      };

      const markFailed = Effect.fn("WebSnippetUploads.markFailed")(function* (
        id: string,
        message: string,
      ) {
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        publish(
          records.map((record) =>
            record.kind === "LOCAL" && record.id === id
              ? {
                  ...record,
                  errorMessage: message,
                  status: "FAILED" as const,
                  updatedAt,
                }
              : record,
          ),
        );
      });

      const promote = (snippet: ApiSnippet) => {
        const published = { kind: "PUBLISHED" as const, snippet };
        const exists = records.some((record) => deviceSnippetRecordId(record) === snippet.id);
        publish(
          orderDeviceSnippetRecords(
            exists
              ? records.map((record) =>
                  deviceSnippetRecordId(record) === snippet.id ? published : record,
                )
              : [published, ...records],
          ),
        );
      };

      const recordPublicationCandidate = Effect.fn("WebSnippetUploads.recordPublicationCandidate")(
        function* (id: string, storageObjectId: string) {
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          publish(
            records.map((record) =>
              record.kind === "LOCAL" && record.id === id
                ? {
                    ...record,
                    publicationCandidate: { storageObjectId },
                    updatedAt,
                  }
                : record,
            ),
          );
        },
      );

      const upload = Effect.fn("WebSnippetUploads.upload")(function* (
        input: WebSnippetUploadInput,
      ) {
        if (records.some((record) => deviceSnippetRecordId(record) === input.id)) return;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const local: LocalUploadRecord = {
          kind: "LOCAL",
          id: input.id,
          fileName: input.fileName,
          byteSize: input.content.size,
          storageProvider: input.storageProvider,
          status: "UPLOADING",
          errorMessage: null,
          publicationCandidate: null,
          createdAt,
          updatedAt: createdAt,
        };
        publish(orderDeviceSnippetRecords([local, ...records]));

        yield* Effect.gen(function* () {
          const prepared = yield* remote.prepare({
            id: input.id,
            fileName: input.fileName,
            byteSize: input.content.size,
            storageProvider: input.storageProvider,
            mediaType: input.mediaType,
          });
          if (prepared.storageProvider !== input.storageProvider) {
            return yield* new WebSnippetUploadError({
              message: "The prepared upload did not match the linked provider.",
            });
          }
          const transferred = yield* transfer.upload({ content: input.content, prepared });
          yield* recordPublicationCandidate(input.id, transferred.storageObjectId);
          const snippet = yield* remote.publish({
            id: input.id,
            fileName: input.fileName,
            byteSize: input.content.size,
            storageProvider: input.storageProvider,
            storageObjectId: transferred.storageObjectId,
          });
          promote(snippet);
        }).pipe(
          Effect.catch((cause) => markFailed(input.id, failureMessage(cause))),
          Effect.onInterrupt(() => markFailed(input.id, interruptedMessage)),
        );
      });

      return WebSnippetUploads.of({
        clear: Effect.sync(() => publish([])),
        dismiss: (id) =>
          Effect.sync(() => {
            const record = records.find(
              (candidate) => candidate.kind === "LOCAL" && candidate.id === id,
            );
            if (record?.kind === "LOCAL" && record.status === "FAILED") {
              publish(
                records.filter((candidate) => !(candidate.kind === "LOCAL" && candidate.id === id)),
              );
            }
          }),
        getSnapshot: () => records,
        replacePublished: (snippets) =>
          Effect.sync(() => publish(reconcileDeviceSnippetRecords(records, snippets))),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        upload,
      });
    }),
  );
}
