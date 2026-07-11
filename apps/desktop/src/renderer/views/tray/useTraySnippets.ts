import { useMemo } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { snippetKindForFileName } from "@plakk/shared";
import type { ApiSnippet, AccountStatus } from "@plakk/shared/PlakkApi";
import { emptySnippetsAtom, snippetReactivityKeys } from "@plakk/ui/atoms/snippets";
import type { UploadTask } from "@plakk/ui/atoms/upload";
import { createPlakkRpc } from "@plakk/ui/atoms/rpc";
import { useActiveUploadTasks, useUploadActions } from "@plakk/ui/hooks/useUploadFlow";
import { AsyncResult } from "effect/unstable/reactivity";
import { uploadStoredSnippet } from "../../lib/storedSnippetUpload.ts";
import { encodeTextSnippet } from "../../lib/textSnippetContent.ts";
import { useAuth } from "../../hooks/useAuth.ts";
import type { ClipboardContent, TrayDroppedItem } from "../../../ipc/contracts.ts";

const plakkRpc = createPlakkRpc(window.ipc.runtimeConfig.plakkRpcUrl);
const prepareUpload = plakkRpc.mutation("PrepareStoredSnippetUpload");
const createSnippet = plakkRpc.mutation("CreateStoredSnippet");
const updateUpload = plakkRpc.mutation("UpdateStoredSnippetUploadStatus");

export function useTraySnippets(account: AccountStatus | null) {
  const auth = useAuth();
  const headers = useMemo(
    () => (auth.accessToken === null ? null : { authorization: `Bearer ${auth.accessToken}` }),
    [auth.accessToken],
  );
  const snippetsAtom = useMemo(
    () =>
      headers === null
        ? emptySnippetsAtom
        : plakkRpc.query(
            "ListSnippets",
            { limit: 1 },
            { headers, reactivityKeys: snippetReactivityKeys },
          ),
    [headers],
  );
  const result = useAtomValue(snippetsAtom);
  const synced = AsyncResult.getOrElse(result, () => ({ items: [] as ReadonlyArray<ApiSnippet> }));
  const uploads = useActiveUploadTasks();
  const actions = useUploadActions();
  const prepare = useAtomSet(prepareUpload, { mode: "promise" });
  const create = useAtomSet(createSnippet, { mode: "promise" });
  const update = useAtomSet(updateUpload, { mode: "promise" });
  const latest: ApiSnippet | UploadTask | undefined = uploads.at(0) ?? synced.items.at(0);
  const provider = account?.storageProvider ?? null;

  const upload = (file: Pick<File, "name" | "size" | "type">, filePath?: string) => {
    if (provider === null || headers === null) return;
    const kind = snippetKindForFileName(file.name);
    if (kind !== "FILE" && kind !== "IMAGE") return;
    const task = actions.enqueue({
      fileName: file.name,
      byteSize: file.size,
      contentType: file.type || null,
      kind,
      storageProvider: provider,
    });
    void uploadStoredSnippet({
      file,
      ...(filePath === undefined ? {} : { filePath }),
      task,
      actions,
      uploader: window.ipc.storage,
      api: {
        prepare: (payload) => prepare({ headers, payload, reactivityKeys: snippetReactivityKeys }),
        create: (payload) => create({ headers, payload, reactivityKeys: snippetReactivityKeys }),
        updateStatus: (payload) =>
          update({ headers, payload, reactivityKeys: snippetReactivityKeys }),
      },
    }).catch(() => undefined);
  };

  const addText = (text: string) => {
    if (provider === null || headers === null) return;
    const bytes = encodeTextSnippet(text.trim());
    if (bytes.byteLength === 0) return;
    const id = crypto.randomUUID();
    const fileName = `${id}.txt`;
    const task = actions.enqueue({
      id,
      fileName,
      byteSize: bytes.byteLength,
      contentType: "text/plain; charset=utf-8",
      kind: "TEXT",
      storageProvider: provider,
    });
    void uploadStoredSnippet({
      file: { name: fileName, size: bytes.byteLength, type: "text/plain; charset=utf-8" },
      bytes,
      task,
      actions,
      uploader: window.ipc.storage,
      api: {
        prepare: (payload) => prepare({ headers, payload, reactivityKeys: snippetReactivityKeys }),
        create: (payload) => create({ headers, payload, reactivityKeys: snippetReactivityKeys }),
        updateStatus: (payload) =>
          update({ headers, payload, reactivityKeys: snippetReactivityKeys }),
      },
    }).catch(() => undefined);
  };

  const addClipboard = async (content: ClipboardContent) => {
    if (content.type === "text") addText(content.text);
    else if (content.type === "image") {
      const blob = await fetch(content.dataUrl).then((response) => response.blob());
      upload({ name: "Pasted image.png", size: blob.size, type: blob.type }, content.path);
    } else if (content.type === "file" && content.size !== undefined)
      upload({ name: content.name, size: content.size, type: "" }, content.path);
  };

  const addDropped = (item: TrayDroppedItem) => {
    if (item.type === "text") addText(item.text);
    else
      for (const file of item.files)
        upload({ name: file.name, size: file.size, type: "" }, file.path);
  };

  return { actions, addClipboard, addDropped, addText, latest, upload };
}
