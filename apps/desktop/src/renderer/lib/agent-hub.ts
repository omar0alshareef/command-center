import type { Agent, AgentLogEntry, TrackerState } from '@command-center/core';
import { isAgentActive } from './derive';

// Pure derivations for the Agent Hub (UI/UX §6.3). Local time is used for days and weeks; storage is UTC.

export const BUILTIN_AGENTS = ['operator', 'system'];
export const isConnectedAgent = (a: Pick<Agent, 'id'>): boolean => !BUILTIN_AGENTS.includes(a.id);

export type AgentState = 'active' | 'idle' | 'error';
export const agentState = (a: Agent, now = Date.now()): AgentState =>
  a.status === 'error' ? 'error' : isAgentActive(a, now) ? 'active' : 'idle';

export interface TreeNode {
  agent: Agent;
  children: Agent[];
}

/** Orchestrators first, sub-agents under their parent; an agent whose parent is not shown becomes a root. */
export function buildTree(agents: readonly Agent[]): TreeNode[] {
  const shown = agents.filter(isConnectedAgent);
  const ids = new Set(shown.map((a) => a.id));
  const byName = (a: Agent, b: Agent) => a.name.localeCompare(b.name);
  const children = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const a of shown) {
    if (a.parent_id && ids.has(a.parent_id)) {
      children.set(a.parent_id, [...(children.get(a.parent_id) ?? []), a]);
    } else roots.push(a);
  }
  const rank = (a: Agent) => (a.type === 'orchestrator' ? 0 : 1);
  roots.sort((a, b) => rank(a) - rank(b) || byName(a, b));
  return roots.map((agent) => ({ agent, children: (children.get(agent.id) ?? []).sort(byName) }));
}

/** Feed rows: the loaded 500 plus any older pages, newest first, no duplicates. */
export function mergeLog(base: readonly AgentLogEntry[], older: readonly AgentLogEntry[]): AgentLogEntry[] {
  if (older.length === 0) return base as AgentLogEntry[];
  const seen = new Set(base.map((e) => e.id));
  return [...base, ...older.filter((e) => !seen.has(e.id))];
}

export function matchesFilter(e: AgentLogEntry, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'manual') return e.agent_id === 'operator';
  if (filter === 'system') return e.agent_id === 'system';
  return e.agent_id === filter;
}

export function matchesSearch(e: AgentLogEntry, query: string, agents: ReadonlyMap<string, Agent>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [e.description, e.target_id, e.action, agents.get(e.agent_id)?.name].some((f) => f?.toLowerCase().includes(q));
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `TODAY`, `YESTERDAY`, else `Mon, Oct 5`. */
export function dayLabel(key: string, now = new Date()): string {
  if (key === localDay(now)) return 'TODAY';
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === localDay(y)) return 'YESTERDAY';
  const [yy, mm, dd] = key.split('-').map(Number) as [number, number, number];
  const d = new Date(yy, mm - 1, dd);
  const base = `${DOW[d.getDay()]}, ${MON[mm - 1]} ${dd}`;
  return yy === now.getFullYear() ? base : `${base}, ${yy}`;
}

export const clockTime = (iso: string): string => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const HEADER_H = 30;
export const ENTRY_H = 56;

export type FeedItem =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'entry'; entry: AgentLogEntry };

/** Entries (newest first) with a day header before each day's first entry. Fixed heights keep scroll math exact. */
export function flattenFeed(entries: readonly AgentLogEntry[], now = new Date()): FeedItem[] {
  const out: FeedItem[] = [];
  let day = '';
  for (const entry of entries) {
    const key = localDay(new Date(entry.timestamp));
    if (key !== day) {
      day = key;
      out.push({ kind: 'header', key, label: dayLabel(key, now) });
    }
    out.push({ kind: 'entry', entry });
  }
  return out;
}

export const itemHeight = (i: FeedItem): number => (i.kind === 'header' ? HEADER_H : ENTRY_H);

/** The same line core hands agents (`buildContextString`), computed from the renderer's snapshot. */
export function contextString(t: TrackerState, now = new Date()): string {
  const days = Math.floor((now.getTime() - Date.parse(t.project.start_date)) / 86_400_000);
  const week = Math.max(1, Math.floor(days / 7) + 1);
  const phase = t.phases.find((p) => p.start_week <= week && week <= p.end_week);
  const done = t.subtasks.filter((s) => s.status === 'done').length;
  const progress = t.subtasks.length === 0 ? 0 : Math.round((done / t.subtasks.length) * 100);
  const blocked = t.subtasks.filter((s) => s.status === 'blocked').length;
  return `WEEK ${week}, Phase: ${phase?.title ?? 'none'}, Progress: ${progress}%, Schedule: ${t.project.schedule_status}, Blocked: ${blocked}`;
}

export interface TodaySummary {
  completed: number;
  inProgress: number;
  blocked: number;
  /** Log actions today per agent, largest first. */
  contributions: { agentId: string; count: number }[];
}

export function todaySummary(t: TrackerState, now = new Date()): TodaySummary {
  const today = localDay(now);
  const counts = new Map<string, number>();
  for (const e of t.agent_log) {
    if (localDay(new Date(e.timestamp)) !== today) continue;
    counts.set(e.agent_id, (counts.get(e.agent_id) ?? 0) + 1);
  }
  return {
    completed: t.subtasks.filter((s) => s.completed_at && localDay(new Date(s.completed_at)) === today).length,
    inProgress: t.subtasks.filter((s) => s.status === 'in_progress').length,
    blocked: t.subtasks.filter((s) => s.status === 'blocked').length,
    contributions: [...counts].map(([agentId, count]) => ({ agentId, count })).sort((a, b) => b.count - a.count),
  };
}

/** Start of the Monday-based local calendar week containing `now`. */
export function weekStart(now: Date): Date {
  const back = (now.getDay() + 6) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
}

export interface AgentWeek {
  agentId: string;
  total: number;
  tags: { tag: string; count: number }[];
}

export function weeklyPerformance(log: readonly AgentLogEntry[], now = new Date()): AgentWeek[] {
  const from = weekStart(now).getTime();
  const per = new Map<string, { total: number; tags: Map<string, number> }>();
  for (const e of log) {
    if (Date.parse(e.timestamp) < from) continue;
    const row = per.get(e.agent_id) ?? { total: 0, tags: new Map<string, number>() };
    row.total++;
    for (const tag of e.tags) row.tags.set(tag, (row.tags.get(tag) ?? 0) + 1);
    per.set(e.agent_id, row);
  }
  return [...per]
    .map(([agentId, r]) => ({
      agentId,
      total: r.total,
      tags: [...r.tags].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, 4),
    }))
    .sort((a, b) => b.total - a.total || a.agentId.localeCompare(b.agentId));
}

/** `C:\Users\me\...\project\command-center.db` shortened in the middle to `max` characters. */
export function middleTruncate(s: string, max = 38): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}

/** Newest activity of any kind (log row or task change), for "Last change 4s ago". */
export function lastChangeAt(t: TrackerState): number | null {
  let best = t.agent_log[0] ? Date.parse(t.agent_log[0].timestamp) : 0;
  for (const s of t.subtasks) best = Math.max(best, Date.parse(s.updated_at));
  return best > 0 ? best : null;
}
