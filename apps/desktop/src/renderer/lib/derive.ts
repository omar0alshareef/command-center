import type { Agent, Milestone, Project, Task, TaskStatus } from '@command-center/core';
import { STATUS_ORDER } from './status';

// Pure derivations over TrackerState, shared by the title bar, tab badges, status bar and views.

export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/** UI/UX §6.3: ACTIVE = acted within the last 5 minutes, or explicitly marked active. */
export function isAgentActive(agent: Agent, now = Date.now()): boolean {
  if (agent.status === 'active') return true;
  return (
    agent.last_action_at !== null && now - Date.parse(agent.last_action_at) <= ACTIVE_WINDOW_MS
  );
}

export function activeAgentCount(agents: readonly Agent[], now = Date.now()): number {
  return agents.filter((a) => isAgentActive(a, now)).length;
}

export function taskCounts(tasks: readonly Task[]): Record<TaskStatus, number> {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of tasks) counts[t.status]++;
  return counts;
}

/** 0..1 share of tasks that are done. */
export function overallProgress(tasks: readonly Task[]): number {
  return tasks.length === 0 ? 0 : tasks.filter((t) => t.status === 'done').length / tasks.length;
}

export type Tone = 'success' | 'warning' | 'danger';

export function scheduleBadge(
  project: Pick<Project, 'schedule_status'>,
  milestones: readonly Pick<Milestone, 'drift_days'>[],
): { label: string; tone: Tone } {
  const maxDrift = Math.max(0, ...milestones.map((m) => m.drift_days));
  if (project.schedule_status === 'behind') {
    return { label: maxDrift > 0 ? `BEHIND · ${maxDrift}d` : 'BEHIND', tone: 'danger' };
  }
  if (project.schedule_status === 'at_risk') return { label: 'AT RISK', tone: 'warning' };
  return { label: 'ON TRACK', tone: 'success' };
}

/** Tasks completed in the calendar week (Monday start, local time) containing `now`. */
export function completedThisWeek(tasks: readonly Task[], now = new Date()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const from = start.getTime();
  return tasks.filter((t) => t.completed_at !== null && Date.parse(t.completed_at) >= from).length;
}

export function initials(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const [a, b] = parts;
  if (a && b) return (a.charAt(0) + b.charAt(0)).toUpperCase();
  return (
    name
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 2)
      .toUpperCase() || '??'
  );
}
