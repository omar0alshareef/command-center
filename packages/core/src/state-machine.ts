import { randomUUID } from 'node:crypto';
import { nowIso, write, type Db } from './db';
import {
  DependenciesIncompleteError,
  IllegalTransitionError,
  ReasonRequiredError,
  TaskNotFoundError,
} from './errors';
import { addLesson } from './lessons';
import { getTask, logAction } from './queries';
import { TASK_STATUSES, type Task, type TaskStatus } from './types';

/** Which statuses each trigger may start from. Blueprint state table + ROADMAP D5. */
export const TRANSITION_RULES = {
  start: ['todo'],
  complete: ['in_progress'],
  approve: ['review'],
  reject: ['review'],
  block: ['todo', 'in_progress', 'review'],
  unblock: ['blocked'],
  reset: TASK_STATUSES,
} as const satisfies Record<string, readonly TaskStatus[]>;

export type Trigger = keyof typeof TRANSITION_RULES;

export interface TransitionPayload {
  /** Agent id doing this. Must be a registered agent. Defaults to the human operator. */
  actor?: string;
  /** Required for `block` and `reject`. Becomes blocked_reason / the lessons_learned entry. */
  reason?: string;
  /** Free-text summary, logged with `complete`. */
  summary?: string;
  /** What blocks the task: another task id, or 'manual' (default). */
  blockedBy?: string;
  /** `start` only: skip the unfinished-dependencies check. */
  force?: boolean;
}

const LOG_ACTION: Record<Trigger, string> = {
  start: 'task_started',
  complete: 'task_completed',
  approve: 'task_approved',
  reject: 'task_rejected',
  block: 'task_blocked',
  unblock: 'task_unblocked',
  reset: 'task_reset',
};

/**
 * The one implementation of every task status change. MCP server, CLI, webhook and the app all
 * call this. Atomic: either the task update, lesson and log row all land, or none do.
 */
export function transition(
  db: Db,
  taskId: string,
  trigger: Trigger,
  payload: TransitionPayload = {},
): Task {
  return write(db, () => {
    const task = getTask(db, taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const allowedFrom: readonly TaskStatus[] = TRANSITION_RULES[trigger];
    if (!allowedFrom.includes(task.status)) {
      throw new IllegalTransitionError(taskId, task.status, trigger, allowedFrom);
    }

    const reason = payload.reason?.trim();
    if ((trigger === 'block' || trigger === 'reject') && !reason) {
      throw new ReasonRequiredError(taskId, trigger);
    }

    if (trigger === 'start' && !payload.force) {
      const unmet = task.depends_on.filter((id) => getTask(db, id)?.status !== 'done');
      if (unmet.length > 0) throw new DependenciesIncompleteError(taskId, unmet);
    }

    const actor = payload.actor ?? 'operator';
    const now = nowIso();
    const next = {
      status: task.status,
      done: task.done,
      completed_at: task.completed_at,
      completed_by: task.completed_by,
      blocked_by: task.blocked_by,
      blocked_reason: task.blocked_reason,
      blocked_from: task.blocked_from,
      last_run_id: task.last_run_id,
    };

    switch (trigger) {
      case 'start':
        next.status = 'in_progress';
        next.last_run_id = randomUUID();
        break;
      case 'complete':
        next.status = 'review';
        break;
      case 'approve':
        next.status = 'done';
        next.done = true;
        next.completed_at = now;
        next.completed_by = task.assignee ?? actor;
        break;
      case 'reject':
        next.status = 'in_progress';
        addLesson(db, taskId, reason ?? '', '', now);
        break;
      case 'block':
        next.status = 'blocked';
        next.blocked_from = task.status;
        next.blocked_by = payload.blockedBy ?? 'manual';
        next.blocked_reason = reason ?? null;
        break;
      case 'unblock':
        next.status = task.blocked_from ?? 'todo';
        next.blocked_from = null;
        next.blocked_by = null;
        next.blocked_reason = null;
        break;
      case 'reset':
        next.status = 'todo';
        next.done = false;
        next.completed_at = null;
        next.completed_by = null;
        next.blocked_from = null;
        next.blocked_by = null;
        next.blocked_reason = null;
        next.last_run_id = null;
        break;
    }

    db.prepare(
      `UPDATE subtasks SET status = @status, done = @done, completed_at = @completed_at,
         completed_by = @completed_by, blocked_by = @blocked_by, blocked_reason = @blocked_reason,
         blocked_from = @blocked_from, last_run_id = @last_run_id, updated_at = @now
       WHERE id = @id`,
    ).run({ ...next, done: next.done ? 1 : 0, now, id: taskId });

    const detail = trigger === 'complete' ? payload.summary?.trim() : reason;
    logAction(db, {
      agentId: actor,
      action: LOG_ACTION[trigger],
      targetType: 'subtask',
      targetId: taskId,
      description: `${taskId}: ${task.status} → ${next.status}${detail ? ` — ${detail}` : ''}`,
      tags: [trigger],
      at: now,
    });

    const updated = getTask(db, taskId);
    if (!updated) throw new TaskNotFoundError(taskId);
    return updated;
  });
}
