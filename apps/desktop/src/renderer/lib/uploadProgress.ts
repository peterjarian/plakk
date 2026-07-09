import type { UploadTask } from "@plakk/ui/atoms/upload";

export type UploadProgressActions = {
  readonly snapshot: () => ReadonlyArray<Pick<UploadTask, "id" | "phase" | "progress">>;
  readonly setProgress: (id: string, progress: number) => void;
  readonly setPhase: (id: string, phase: UploadTask["phase"]) => void;
};

export const nextUploadProgress = (task: Pick<UploadTask, "progress">): number =>
  Math.min(100, task.progress + 8);

export function advanceUploadProgress(actions: UploadProgressActions) {
  for (const task of actions.snapshot()) {
    if (task.phase === "READY") continue;

    const progress = nextUploadProgress(task);
    actions.setProgress(task.id, progress);
    if (progress === 100) actions.setPhase(task.id, "READY");
  }
}

export function startUploadProgress(actions: UploadProgressActions) {
  const timer = window.setInterval(() => advanceUploadProgress(actions), 160);
  return () => window.clearInterval(timer);
}
