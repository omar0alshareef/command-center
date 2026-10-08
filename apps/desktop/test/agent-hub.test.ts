import { buildContextString, getAllTrackerState, type Agent, type AgentLogEntry } from '@command-center/core';
import { describe, expect, it } from 'vitest';
import { seedDb } from '../../../packages/core/src/seed';
import { tmpDb } from '../../../packages/core/test/helpers';
import {
  buildTree,
  contextString,
  dayLabel,
  flattenFeed,
  matchesFilter,
  matchesSearch,
  mergeLog,
  middleTruncate,
  todaySummary,
  weeklyPerformance,
  weekStart,
} from '../src/renderer/lib/agent-hub';

const agent = (id: string, over: Partial<Agent> = {}) =>
  ({ id, name: id, type: 'orchestrator', parent_id: null, status: 'idle', last_action_at: null, ...over }) as Agent;
const log = (id: string, agent_id: string, timestamp: string, over: Partial<AgentLogEntry> = {}) =>
  ({ id, agent_id, action: 'x', target_type: null, target_id: null, description: null, timestamp, tags: [], ...over }) as AgentLogEntry;

describe('agent tree', () => {
  it('nests sub-agents under their parent, orchestrators first, built-ins hidden', () => {
    const tree = buildTree([
      agent('operator', { type: 'human' }),
      agent('system', { type: 'external' }),
      agent('zed', { type: 'external' }),
      agent('b-sub', { type: 'sub-agent', parent_id: 'alpha' }),
      agent('a-sub', { type: 'sub-agent', parent_id: 'alpha' }),
      agent('alpha'),
      agent('orphan', { type: 'sub-agent', parent_id: 'gone' }),
    ]);
    expect(tree.map((n) => n.agent.id)).toEqual(['alpha', 'orphan', 'zed']);
    expect(tree[0]?.children.map((c) => c.id)).toEqual(['a-sub', 'b-sub']);
  });
});

describe('feed', () => {
  const agents = new Map([['claude', agent('claude', { name: 'Claude Code' })]]);
  it('filters by agent / manual / system and searches description, target, action and agent name', () => {
    const e = log('1', 'claude', '2026-10-08T10:00:00Z', { description: 'Ran the tests', target_id: 'TASK-014', action: 'tests_passed' });
    expect(matchesFilter(e, 'claude')).toBe(true);
    expect(matchesFilter(e, 'manual')).toBe(false);
    expect(matchesFilter(log('2', 'operator', e.timestamp), 'manual')).toBe(true);
    expect(matchesFilter(log('3', 'system', e.timestamp), 'system')).toBe(true);
    for (const q of ['tests', 'task-014', 'passed', 'claude code', '  ']) expect(matchesSearch(e, q, agents)).toBe(true);
    expect(matchesSearch(e, 'nope', agents)).toBe(false);
  });
  it('merges older pages without duplicates, keeping order', () => {
    const a = log('a', 'x', '2026-10-08T10:00:00Z');
    const b = log('b', 'x', '2026-10-07T10:00:00Z');
    expect(mergeLog([a], [a, b]).map((e) => e.id)).toEqual(['a', 'b']);
  });
  it('groups by local day with TODAY / YESTERDAY / dated headers', () => {
    const now = new Date(2026, 9, 8, 15, 0);
    const mk = (d: Date, id: string) => log(id, 'x', d.toISOString());
    const items = flattenFeed([mk(new Date(2026, 9, 8, 14), 'a'), mk(new Date(2026, 9, 8, 9), 'b'), mk(new Date(2026, 9, 7, 23), 'c'), mk(new Date(2026, 9, 5, 12), 'd')], now);
    expect(items.filter((i) => i.kind === 'header').map((h) => (h as { label: string }).label)).toEqual(['TODAY', 'YESTERDAY', 'Mon, Oct 5']);
    expect(items.map((i) => i.kind)).toEqual(['header', 'entry', 'entry', 'header', 'entry', 'header', 'entry']);
    expect(dayLabel('2025-01-02', now)).toBe('Thu, Jan 2, 2025');
  });
});

describe('summaries', () => {
  it('weeks start on Monday (local)', () => {
    expect(weekStart(new Date(2026, 9, 11, 12)).getDate()).toBe(5); // Sun Oct 11 -> Mon Oct 5
    expect(weekStart(new Date(2026, 9, 5, 0, 1)).getDate()).toBe(5);
  });
  it('counts this week per agent with top tags, ignoring older rows', () => {
    const now = new Date(2026, 9, 8, 12);
    const at = (d: number, h = 10) => new Date(2026, 9, d, h).toISOString();
    const rows = [
      log('1', 'a', at(8), { tags: ['quality', 'tests'] }),
      log('2', 'a', at(6), { tags: ['quality'] }),
      log('3', 'b', at(7)),
      log('4', 'a', at(4)), // previous Sunday
    ];
    const w = weeklyPerformance(rows, now);
    expect(w.map((r) => [r.agentId, r.total])).toEqual([['a', 2], ['b', 1]]);
    expect(w[0]?.tags[0]).toEqual({ tag: 'quality', count: 2 });
  });
  it('summarises today: completions, in-progress, blocked, per-agent actions', () => {
    const now = new Date(2026, 9, 8, 12);
    const t = {
      subtasks: [
        { status: 'done', completed_at: new Date(2026, 9, 8, 9).toISOString() },
        { status: 'done', completed_at: new Date(2026, 9, 7, 9).toISOString() },
        { status: 'in_progress', completed_at: null },
        { status: 'blocked', completed_at: null },
      ],
      agent_log: [log('1', 'a', new Date(2026, 9, 8, 8).toISOString()), log('2', 'a', new Date(2026, 9, 8, 9).toISOString()), log('3', 'b', new Date(2026, 9, 8, 9).toISOString()), log('4', 'b', new Date(2026, 9, 7, 9).toISOString())],
    } as never;
    expect(todaySummary(t, now)).toEqual({ completed: 1, inProgress: 1, blocked: 1, contributions: [{ agentId: 'a', count: 2 }, { agentId: 'b', count: 1 }] });
  });
  it('truncates long paths in the middle', () => {
    const p = 'C:/Users/someone/Desktop/Claude/command-center/command-center.db';
    const s = middleTruncate(p, 30);
    expect(s).toHaveLength(30);
    expect(s.startsWith('C:/Users')).toBe(true);
    expect(s.endsWith('command-center.db')).toBe(true);
    expect(middleTruncate('short', 30)).toBe('short');
  });
});

describe('context injection preview', () => {
  it("matches core's buildContextString exactly on the seed project", () => {
    const t = tmpDb();
    try {
      const now = new Date();
      seedDb(t.db, { now });
      const tracker = getAllTrackerState(t.db);
      expect(contextString(tracker, now)).toBe(buildContextString(t.db, now));
    } finally {
      t.cleanup();
    }
  });
});
