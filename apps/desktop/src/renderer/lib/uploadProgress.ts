import type { UploadTask } from "@plakk/ui/atoms/upload";

export const nextUploadProgress = (task: Pick<UploadTask, "progress">): number =>
  Math.min(100, task.progress + 8);
