import { randomUUID } from 'node:crypto';
import { nowIso, write, type Db } from './db';
import {
  DependenciesIncompleteError,
  IllegalTransitionError,
  ReasonRequiredError,
  SelfApprovalError,
  TaskNotFoundError,
} from './errors';
import { sameAgentFamily } from './agents';
import { addLesson } from './lessons';
import { getAgent, getTask, logAction } from './queries';
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

/**
 * Extra starting statuses allowed when the caller confirms skipping workflow steps
 * (UI/UX §6.2: todo→review, todo→done, in_progress→done). Only with `skipSteps: true`.
 */
const SKIP_FROM: Partial<Record<Trigger, readonly TaskStatus[]>> = {
  complete: ['todo', 'in_progress'],
  approve: ['todo', 'in_progress', 'review'],
};

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
  /** `complete` / `approve` only: the caller confirmed skipping steps (e.g. todo → done). */
  skipSteps?: boolean;
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
 * Review must be independent. An agent may not approve work that was last submitted for review by
 * itself or by an agent in its own family (parent or sub-agent), which would otherwise be possible by
 * registering a throwaway sub-agent. Humans (the operator) may approve anything. With no recorded
 * submission (e.g. a task that was set to review directly) there is nobody to conflict with.
 */
function assertIndependentApproval(db: Db, taskId: string, actor: string): void {
  const agent = getAgent(db, actor);
  if (!agent || agent.type === 'human') return;
  const last = db
    .prepare(
      "SELECT agent_id FROM agent_log WHERE target_id = ? AND action = 'task_completed' ORDER BY timestamp DESC, rowid DESC LIMIT 1",
    )
    .get(taskId) as { agent_id: string } | undefined;
  if (last && sameAgentFamily(db, actor, last.agent_id)) {
    throw new SelfApprovalError(taskId, actor, last.agent_id);
  }
}

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

    const baseFrom: readonly TaskStatus[] = TRANSITION_RULES[trigger];
    const allowedFrom = payload.skipSteps ? (SKIP_FROM[trigger] ?? baseFrom) : baseFrom;
    if (!allowedFrom.includes(task.status)) {
      throw new IllegalTransitionError(taskId, task.status, trigger, allowedFrom);
    }
    const skipped = !baseFrom.includes(task.status);

    const reason = payload.reason?.trim();
    if ((trigger === 'block' || trigger === 'reject') && !reason) {
      throw new ReasonRequiredError(taskId, trigger);
    }

    if (trigger === 'start' && !payload.force) {
      const unmet = task.depends_on.filter((id) => getTask(db, id)?.status !== 'done');
      if (unmet.length > 0) throw new DependenciesIncompleteError(taskId, unmet);
    }

    const actor = payload.actor ?? 'operator';
    if (trigger === 'approve') assertIndependentApproval(db, taskId, actor);
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
      started_at: task.started_at,
    };

    switch (trigger) {
      case 'start':
        next.status = 'in_progress';
        next.last_run_id = randomUUID();
        next.started_at = now; // kept through review/reject so the board's timer is total elapsed
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
        next.started_at = null;
        break;
    }

    db.prepare(
      `UPDATE subtasks SET status = @status, done = @done, completed_at = @completed_at,
         completed_by = @completed_by, blocked_by = @blocked_by, blocked_reason = @blocked_reason,
         blocked_from = @blocked_from, last_run_id = @last_run_id, started_at = @started_at,
         updated_at = @now
       WHERE id = @id`,
    ).run({ ...next, done: next.done ? 1 : 0, now, id: taskId });

    const detail = trigger === 'complete' ? payload.summary?.trim() : reason;
    logAction(db, {
      agentId: actor,
      action: LOG_ACTION[trigger],
      targetType: 'subtask',
      targetId: taskId,
      description: `${taskId}: ${task.status} → ${next.status}${skipped ? ' (steps skipped)' : ''}${detail ? ` — ${detail}` : ''}`,
      tags: [trigger],
      at: now,
    });

    const updated = getTask(db, taskId);
    if (!updated) throw new TaskNotFoundError(taskId);
    return updated;
  });
}
