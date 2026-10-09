import type { Task, TaskPatch } from '@command-center/core';
import { optimisticPatch, type Move } from '../views/task-board/moves';
import { useApp } from '../store';
import { toast } from '../toast';

// Renderer-side task mutations: optimistic update -> IPC -> reconcile, rolling back with a toast on
// failure (UI/UX §6.2). All validation lives in core; the UI never decides what is legal on its own.
// Refetches are held while a mutation is in flight so a stale snapshot can't flicker over the
// optimistic state; the deferred refetch runs right after.

/** Run a status transition. Resolves true on success. */
export async function transitionTask(task: Task, move: Move): Promise<boolean> {
  const { patchTask, replaceTask, refresh, holdSync, releaseSync } = useApp.getState();
  holdSync();
  try {
    patchTask(task.id, optimisticPatch(task, move));
    const res = await window.api.tasks.transition({
      taskId: task.id,
      trigger: move.trigger,
      payload: move.payload,
    });
    if (!res.ok) {
      replaceTask(task); // roll back, then re-sync in case something else changed meanwhile
      void refresh();
      toast.error(res.error.message);
      return false;
    }
    replaceTask(res.value);
    return true;
  } finally {
    releaseSync();
  }
}

/** Save field edits (autosave). Resolves to the updated task, or null if it failed. */
export async function saveTaskFields(taskId: string, patch: TaskPatch): Promise<Task | null> {
  const { replaceTask, holdSync, releaseSync } = useApp.getState();
  holdSync();
  try {
    const res = await window.api.tasks.update({ taskId, patch });
    if (!res.ok) {
      toast.error(res.error.message);
      return null;
    }
    replaceTask(res.value);
    return res.value;
  } finally {
    releaseSync();
  }
}

export async function createTask(milestoneId: string, label: string): Promise<Task | null> {
  const res = await window.api.tasks.create({ milestoneId, label });
  if (!res.ok) {
    toast.error(res.error.message);
    return null;
  }
  void useApp.getState().refresh(); // the new row is not in the store yet
  return res.value;
}

/** Permanently delete a task. Resolves true on success; the open modal closes once the refresh drops the row. */
export async function deleteTask(taskId: string): Promise<boolean> {
  const res = await window.api.tasks.delete(taskId);
  if (!res.ok) {
    toast.error(res.error.message);
    return false;
  }
  toast.info(`${taskId} deleted`);
  await useApp.getState().refresh();
  return true;
}
