import type { TaskStatus } from '@command-center/core';

// Single source of truth for status -> label/color (UI/UX §4.3). Colors are CSS variables, never hex.
// Do not import runtime values from @command-center/core here: it pulls in the native DB module.

export const STATUS_ORDER: readonly TaskStatus[] = [
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked',
];

export const STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: 'TO DO', color: 'var(--muted)' },
  in_progress: { label: 'IN PROGRESS', color: 'var(--accent)' },
  review: { label: 'REVIEW', color: 'var(--warning)' },
  done: { label: 'DONE', color: 'var(--success)' },
  blocked: { label: 'BLOCKED', color: 'var(--danger)' },
};

/** Sentence-case names for messages ("returns it to In Progress"). */
export const STATUS_NAME: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  blocked: 'Blocked',
};

export const PRIORITY_COLOR: Record<string, string> = {
  P0: 'var(--danger)',
  P1: 'var(--warning)',
  P2: 'var(--muted)',
  P3: 'var(--muted)',
};

// Domain palette (UI/UX §4.4): assigned in order of first appearance.
export const DOMAIN_COLORS = [
  '#f59e0b',
  '#22c55e',
  '#8286FF',
  '#ef4444',
  '#14B8A6',
  '#EC4899',
  '#F97316',
  '#6366F1',
  '#06B6D4',
  '#9B9BAA',
];

export function domainColor(domain: string, allDomains: readonly string[]): string {
  const i = allDomains.indexOf(domain);
  return DOMAIN_COLORS[(i < 0 ? 0 : i) % DOMAIN_COLORS.length] ?? '#9B9BAA';
}

export const HYDRATION_PROMPT = `Hydrate the Command Center with my project. I will provide a manifesto and a roadmap.

1. Extract my domains and create swim lane lanes with colors.
2. Extract my phases and create schedule phases.
3. Extract my milestones and create them with planned dates (create_milestone).
4. Extract my deliverables and create subtasks (add_milestone_task).
5. Register my agent roster with source model bindings (register_agent).

Manifesto:
<paste here>

Roadmap:
<paste here>`;
