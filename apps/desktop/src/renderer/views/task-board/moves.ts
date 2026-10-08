import type { Task, TaskStatus, Trigger } from '@command-center/core';
import type { RendererTransitionPayload } from '../../../shared/ipc';
import { STATUS_NAME } from '../../lib/status';

// UI/UX §6.2 "state machine as UX rules", as one pure function used by drag-and-drop AND the task
// modal's buttons, so every entry point behaves identically.

export interface Move {
  trigger: Trigger;
  payload: RendererTransitionPayload;
}

export type MovePlan =
  | { kind: 'noop' }
  | { kind: 'illegal'; message: string }
  /** Safe to run immediately. */
  | { kind: 'direct'; move: Move }
  /** Block / reject need a reason from the operator (required). */
  | { kind: 'reason'; trigger: 'block' | 'reject'; title: string; prompt: string }
  /** in_progress -> review: optional summary. */
  | { kind: 'summary'; move: Move; title: string }
  /** Needs an explicit yes first (skipping steps, unmet dependencies). */
  | { kind: 'confirm'; move: Move; title: string; body: string; confirmLabel: string };

export function unmetDependencies(task: Task, byId: ReadonlyMap<string, Task>): string[] {
  return task.depends_on.filter((id) => byId.get(id)?.status !== 'done');
}

export function planMove(task: Task, to: TaskStatus, byId: ReadonlyMap<string, Task>): MovePlan {
  const from = task.status;
  if (from === to) return { kind: 'noop' };

  if (from === 'blocked') {
    const back = task.blocked_from ?? 'todo';
    return to === back
      ? { kind: 'direct', move: { trigger: 'unblock', payload: {} } }
      : {
          kind: 'illegal',
          message: `${task.id} is blocked. Unblocking returns it to ${STATUS_NAME[back]}.`,
        };
  }
  if (from === 'done') {
    return {
      kind: 'illegal',
      message: `${task.id} is done. Open it and use Reset to start over.`,
    };
  }
  if (to === 'blocked') {
    return {
      kind: 'reason',
      trigger: 'block',
      title: `Block ${task.id}`,
      prompt: 'Why is this blocked?',
    };
  }
  if (to === 'todo') {
    return {
      kind: 'illegal',
      message: `Moving ${task.id} back to To Do is not a workflow step. Open it and use Reset.`,
    };
  }

  if (from === 'todo' && to === 'in_progress') {
    const unmet = unmetDependencies(task, byId);
    return unmet.length === 0
      ? { kind: 'direct', move: { trigger: 'start', payload: {} } }
      : {
          kind: 'confirm',
          move: { trigger: 'start', payload: { force: true } },
          title: 'Dependencies incomplete',
          body: `${task.id} depends on ${unmet.join(', ')}, which is not done. Start anyway?`,
          confirmLabel: 'Start anyway',
        };
  }
  if (from === 'in_progress' && to === 'review') {
    return {
      kind: 'summary',
      move: { trigger: 'complete', payload: {} },
      title: `Submit ${task.id} for review`,
    };
  }
  if (from === 'review' && to === 'done') {
    return { kind: 'direct', move: { trigger: 'approve', payload: {} } };
  }
  if (from === 'review' && to === 'in_progress') {
    return {
      kind: 'reason',
      trigger: 'reject',
      title: `Reject ${task.id}`,
      prompt: 'What needs to change? This is saved as a lesson learned.',
    };
  }
  if (from === 'todo' && to === 'review') {
    return {
      kind: 'confirm',
      move: { trigger: 'complete', payload: { skipSteps: true } },
      title: 'Skip steps?',
      body: `${task.id} has not been started. Move it straight to Review?`,
      confirmLabel: 'Skip to Review',
    };
  }
  // todo -> done, in_progress -> done
  return {
    kind: 'confirm',
    move: { trigger: 'approve', payload: { skipSteps: true } },
    title: 'Skip review?',
    body:
      from === 'todo'
        ? `${task.id} has not been started or reviewed. Mark it done anyway?`
        : `${task.id} has not been reviewed. Mark it done anyway?`,
    confirmLabel: 'Mark done',
  };
}

/** Best-guess task fields while the IPC call is in flight; the server's answer replaces them. */
export function optimisticPatch(task: Task, move: Move): Partial<Task> {
  switch (move.trigger) {
    case 'start':
    case 'reject':
      return { status: 'in_progress' };
    case 'complete':
      return { status: 'review' };
    case 'approve':
      return { status: 'done', done: true };
    case 'block':
      return {
        status: 'blocked',
        blocked_from: task.status,
        blocked_by: move.payload.blockedBy ?? 'manual',
        blocked_reason: move.payload.reason ?? null,
      };
    case 'unblock':
      return {
        status: task.blocked_from ?? 'todo',
        blocked_from: null,
        blocked_by: null,
        blocked_reason: null,
      };
    case 'reset':
      return {
        status: 'todo',
        done: false,
        completed_at: null,
        completed_by: null,
        blocked_from: null,
        blocked_by: null,
        blocked_reason: null,
      };
  }
}
