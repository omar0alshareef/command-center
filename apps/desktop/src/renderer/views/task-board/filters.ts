import type { Agent, Task } from '@command-center/core';

export const UNASSIGNED = '__unassigned__';

export type Segment = 'all' | 'mine' | 'agent' | 'blocked';

export interface Filters {
  segment: Segment;
  search: string;
  priorities: string[];
  /** Agent ids, or UNASSIGNED. */
  assignees: string[];
}

export const NO_FILTERS: Filters = { segment: 'all', search: '', priorities: [], assignees: [] };

export function isFiltering(f: Filters): boolean {
  return (
    f.segment !== 'all' ||
    f.search.trim() !== '' ||
    f.priorities.length > 0 ||
    f.assignees.length > 0
  );
}

export function applyFilters(
  tasks: readonly Task[],
  agentsById: ReadonlyMap<string, Pick<Agent, 'type'>>,
  f: Filters,
): Task[] {
  const q = f.search.trim().toLowerCase();
  return tasks.filter((t) => {
    if (f.segment === 'blocked' && t.status !== 'blocked') return false;
    if (
      f.segment === 'mine' &&
      (t.assignee === null || agentsById.get(t.assignee)?.type !== 'human')
    ) {
      return false;
    }
    if (f.segment === 'agent') {
      const type = t.assignee === null ? undefined : agentsById.get(t.assignee)?.type;
      if (type === undefined || type === 'human') return false;
    }
    if (q && !t.id.toLowerCase().includes(q) && !t.label.toLowerCase().includes(q)) return false;
    if (f.priorities.length > 0 && !f.priorities.includes(t.priority)) return false;
    if (f.assignees.length > 0 && !f.assignees.includes(t.assignee ?? UNASSIGNED)) return false;
    return true;
  });
}

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** In-column order (UI/UX §6.2): priority, then most recently updated. Manual ordering is v1.1. */
export function compareTasks(a: Task, b: Task): number {
  return (
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
    b.updated_at.localeCompare(a.updated_at) ||
    a.id.localeCompare(b.id)
  );
}
