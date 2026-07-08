import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import type { PropsWithChildren } from "react";
import { createElement, useContext, useMemo } from "react";

import {
  activeUploadTasksAtom,
  makeUploadTask,
  removeUploadTask,
  updateUploadTask,
  uploadTasksAtom,
  upsertUploadTask,
  type UploadDraft,
  type UploadPhase,
  type UploadTask,
} from "../atoms/upload.ts";

export let uploadAtomRegistry = AtomRegistry.make();

export function UploadAtomRegistryProvider({ children }: PropsWithChildren) {
  return createElement(RegistryContext.Provider, { value: uploadAtomRegistry }, children);
}

export function resetUploadAtomRegistryForTests() {
  uploadAtomRegistry.dispose();
  uploadAtomRegistry = AtomRegistry.make();
}

export function useUploadTasks(): ReadonlyArray<UploadTask> {
  return useAtomValue(uploadTasksAtom);
}

export function useActiveUploadTasks(): ReadonlyArray<UploadTask> {
  return useAtomValue(activeUploadTasksAtom);
}

export function useUploadActions() {
  const registry = useContext(RegistryContext);
  const setTasks = useAtomSet(uploadTasksAtom);

  return useMemo(
    () => ({
      enqueue(draft: UploadDraft) {
        const task = makeUploadTask(draft);
        setTasks((tasks) => upsertUploadTask(tasks, task));
        return task;
      },
      upsert(task: UploadTask) {
        setTasks((tasks) => upsertUploadTask(tasks, task));
      },
      setPhase(id: string, phase: UploadPhase, errorMessage: string | null = null) {
        setTasks((tasks) =>
          updateUploadTask(tasks, id, (task) => ({
            ...task,
            phase,
            errorMessage,
          })),
        );
      },
      setProgress(id: string, progress: number) {
        setTasks((tasks) =>
          updateUploadTask(tasks, id, (task) => ({
            ...task,
            progress: Math.max(0, Math.min(100, progress)),
          })),
        );
      },
      setStorageObjectId(id: string, storageObjectId: string | null) {
        setTasks((tasks) =>
          updateUploadTask(tasks, id, (task) => ({
            ...task,
            storageObjectId,
          })),
        );
      },
      remove(id: string) {
        setTasks((tasks) => removeUploadTask(tasks, id));
      },
      snapshot() {
        return registry.get(uploadTasksAtom);
      },
    }),
    [registry, setTasks],
  );
}
