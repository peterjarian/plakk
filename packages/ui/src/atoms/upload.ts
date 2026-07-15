import type { StorageProvider } from "@plakk/shared";
import { Atom } from "effect/unstable/reactivity";

export type UploadPhase = "QUEUED" | "PREPARING" | "UPLOADING" | "UPLOADED" | "FAILED";

export type UploadDraft = {
  readonly id?: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly contentType: string | null;
  readonly storageProvider: StorageProvider;
};

export type UploadTask = Required<Pick<UploadDraft, "id">> &
  Omit<UploadDraft, "id"> & {
    readonly phase: UploadPhase;
    readonly progress: number;
    readonly storageObjectId: string | null;
    readonly errorMessage: string | null;
  };

export const uploadTasksAtom = Atom.make<ReadonlyArray<UploadTask>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("plakk:storage-upload-tasks"),
);

export const activeUploadTasksAtom = Atom.make((get) =>
  get(uploadTasksAtom).filter((task) => task.phase !== "UPLOADED"),
).pipe(Atom.withLabel("plakk:active-storage-upload-tasks"));

export const makeUploadTask = (draft: UploadDraft): UploadTask => ({
  ...draft,
  id: draft.id ?? crypto.randomUUID(),
  phase: "QUEUED",
  progress: 0,
  storageObjectId: null,
  errorMessage: null,
});

export const upsertUploadTask = (
  tasks: ReadonlyArray<UploadTask>,
  task: UploadTask,
): ReadonlyArray<UploadTask> =>
  tasks.some((current) => current.id === task.id)
    ? tasks.map((current) => (current.id === task.id ? task : current))
    : [task, ...tasks];

export const updateUploadTask = (
  tasks: ReadonlyArray<UploadTask>,
  id: string,
  update: (task: UploadTask) => UploadTask,
): ReadonlyArray<UploadTask> => tasks.map((task) => (task.id === id ? update(task) : task));

export const removeUploadTask = (
  tasks: ReadonlyArray<UploadTask>,
  id: string,
): ReadonlyArray<UploadTask> => tasks.filter((task) => task.id !== id);
