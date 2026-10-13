import type { PlanCounts, Proposal, Task, TeamRole } from '@command-center/core';

// Pure helpers for the Planning view, the milestone panel and the board. The renderer may only import
// types from core (its runtime pulls in the native SQLite module), so these small pieces live here.

/** Rename a team role (id and/or name); tasks assigned to it follow the new id. */
export function renameRole(
  p: Proposal,
  oldId: string,
  next: { id: string; name: string },
): Proposal {
  return {
    ...p,
    team: p.team.map((r) => (r.id === oldId ? { ...r, ...next } : r)),
    tasks: p.tasks.map((t) => (t.assignee === oldId ? { ...t, assignee: next.id } : t)),
  };
}

/** Remove a role from the roster; its tasks become unassigned. */
export function removeRole(p: Proposal, id: string): Proposal {
  return {
    ...p,
    team: p.team.filter((r) => r.id !== id),
    tasks: p.tasks.map((t) => (t.assignee === id ? { ...t, assignee: null } : t)),
  };
}

export function addRole(p: Proposal, name: string): Proposal {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'role';
  let id = base;
  for (let i = 2; p.team.some((r) => r.id === id); i++) id = `${base}-${i}`;
  const role: TeamRole = { id, name: name.trim() || id, capabilities: [], milestones: [] };
  return { ...p, team: [...p.team, role] };
}

/** The roles a milestone needs, in roster order. */
export const rolesFor = (team: readonly TeamRole[], milestoneId: string): TeamRole[] =>
  team.filter((r) => r.milestones.includes(milestoneId));

export function countPlan(p: Proposal): PlanCounts {
  return {
    milestones: p.milestones.length,
    tasks: p.tasks.length,
    withDeadlines: p.tasks.filter((t) => t.due_date).length,
    dependencies: p.tasks.reduce((n, t) => n + t.depends_on.length, 0),
    agents: p.team.length,
  };
}

/** Local calendar day as YYYY-MM-DD. */
export function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Past due = has a deadline before today (local) and is not done. */
export const isPastDue = (t: Pick<Task, 'due_date' | 'status'>, today = localDay()): boolean =>
  Boolean(t.due_date) && t.status !== 'done' && (t.due_date ?? '') < today;

/**
 * The roadmap section for a milestone: from the first heading that names its id (as a whole word)
 * or its exact title, up to the next heading of the same or a higher level. Null if none matches.
 */
export function roadmapSection(markdown: string, id: string, title?: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idRe = new RegExp(`(^|[^A-Za-z0-9_-])${esc}([^A-Za-z0-9_-]|$)`);
  const heading = (l: string) => /^(#{1,6})\s+(.*)$/.exec(l);
  const start = lines.findIndex((l) => {
    const h = heading(l);
    return Boolean(h && (idRe.test(h[2] ?? '') || (title && (h[2] ?? '').trim() === title.trim())));
  });
  if (start < 0) return null;
  const level = heading(lines[start] ?? '')?.[1]?.length ?? 6;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = heading(lines[i] ?? '');
    if (h && (h[1]?.length ?? 7) <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}
