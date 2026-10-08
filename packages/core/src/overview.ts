import { isAgentActive } from './agents';
import { buildContextString, currentWeek } from './context';
import type { Db } from './db';
import {
  getActivityFeed,
  getMilestone,
  getProject,
  getTask,
  listAgents,
  listMilestones,
  listPhases,
  listTasks,
} from './queries';
import { TASK_STATUSES, type TaskStatus } from './types';

// Compact, agent-facing read models. Everything here is derived from rows; nothing is written.

const countBy = (statuses: readonly TaskStatus[]): Record<TaskStatus, number> =>
  Object.fromEntries(
    TASK_STATUSES.map((s) => [s, statuses.filter((x) => x === s).length]),
  ) as Record<TaskStatus, number>;

export interface ProjectStatus {
  name: string;
  week: number;
  phase: string | null;
  progress_pct: number;
  schedule_status: string;
  max_drift_days: number;
  tasks: Record<TaskStatus, number>;
  total_tasks: number;
  blocked: { id: string; label: string; reason: string | null }[];
  awaiting_review: { id: string; label: string }[];
  agents: { total: number; active: number };
  context: string;
}

export function getProjectStatus(db: Db, now = new Date()): ProjectStatus {
  const project = getProject(db);
  const tasks = listTasks(db);
  const week = currentWeek(project.start_date, now);
  const done = tasks.filter((t) => t.status === 'done').length;
  const agents = listAgents(db);
  return {
    name: project.name,
    week,
    phase: listPhases(db).find((p) => p.start_week <= week && week <= p.end_week)?.title ?? null,
    progress_pct: tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100),
    schedule_status: project.schedule_status,
    max_drift_days: Math.max(0, ...listMilestones(db).map((m) => m.drift_days)),
    tasks: countBy(tasks.map((t) => t.status)),
    total_tasks: tasks.length,
    blocked: tasks
      .filter((t) => t.status === 'blocked')
      .map((t) => ({ id: t.id, label: t.label, reason: t.blocked_reason })),
    awaiting_review: tasks
      .filter((t) => t.status === 'review')
      .map((t) => ({ id: t.id, label: t.label })),
    agents: {
      total: agents.length,
      active: agents.filter((a) => isAgentActive(a, now.getTime())).length,
    },
    context: buildContextString(db, now),
  };
}

export interface MilestoneOverview {
  id: string;
  title: string;
  domain: string;
  week: number;
  phase: string | null;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  drift_days: number;
  key_milestone: string | null;
  dependencies: string[];
  progress: { done: number; total: number; by_status: Record<TaskStatus, number> };
  recent_notes: { text: string; author: string; at: string }[];
}

/** One milestone (by id) or all of them, with task progress. Returns [] for an unknown id. */
export function getMilestoneOverview(db: Db, id?: string): MilestoneOverview[] {
  const milestones = id ? [getMilestone(db, id)].filter((m) => m !== null) : listMilestones(db);
  const tasks = listTasks(db);
  return milestones.map((m) => {
    const mine = tasks.filter((t) => t.milestone_id === m.id);
    return {
      id: m.id,
      title: m.title,
      domain: m.domain,
      week: m.week,
      phase: m.phase,
      planned_start: m.planned_start,
      planned_end: m.planned_end,
      actual_start: m.actual_start,
      actual_end: m.actual_end,
      drift_days: m.drift_days,
      key_milestone: m.is_key_milestone ? (m.key_milestone_label ?? m.title) : null,
      dependencies: m.dependencies,
      progress: {
        done: mine.filter((t) => t.status === 'done').length,
        total: mine.length,
        by_status: countBy(mine.map((t) => t.status)),
      },
      recent_notes: m.notes.slice(-3),
    };
  });
}

export interface TaskSummary {
  id: string;
  label: string;
  status: TaskStatus;
  priority: string;
  assignee: string | null;
  milestone: { id: string; title: string } | null;
  criteria: { done: number; total: number; open: string[] };
  blocked: { by: string | null; reason: string | null } | null;
  depends_on: { id: string; status: TaskStatus | 'missing' }[];
  last_event: { at: string; agent: string; action: string; description: string | null } | null;
}

/** ~500-token snapshot of a task: enough to decide what to do next without the full context. */
export function getTaskSummary(db: Db, taskId: string): TaskSummary | null {
  const t = getTask(db, taskId);
  if (!t) return null;
  const milestone = getMilestone(db, t.milestone_id);
  const last = getActivityFeed(db, { targetId: taskId, limit: 1 })[0];
  const open = t.acceptance_criteria.filter((c) => !c.done);
  return {
    id: t.id,
    label: t.label,
    status: t.status,
    priority: t.priority,
    assignee: t.assignee,
    milestone: milestone ? { id: milestone.id, title: milestone.title } : null,
    criteria: {
      done: t.acceptance_criteria.length - open.length,
      total: t.acceptance_criteria.length,
      open: open.slice(0, 5).map((c) => c.text.slice(0, 120)),
    },
    blocked: t.status === 'blocked' ? { by: t.blocked_by, reason: t.blocked_reason } : null,
    depends_on: t.depends_on.map((id) => ({ id, status: getTask(db, id)?.status ?? 'missing' })),
    last_event: last
      ? {
          at: last.timestamp,
          agent: last.agent_id,
          action: last.action,
          description: last.description?.slice(0, 160) ?? null,
        }
      : null,
  };
}
