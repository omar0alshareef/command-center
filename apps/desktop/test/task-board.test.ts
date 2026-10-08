import type { Agent, Task, TaskStatus, TrackerState } from '@command-center/core';
import { describe, expect, it } from 'vitest';
import { mergeTracker } from '../src/renderer/lib/share';
import { elapsed, relativeTime } from '../src/renderer/lib/time';
import {
  applyFilters,
  compareTasks,
  NO_FILTERS,
  UNASSIGNED,
} from '../src/renderer/views/task-board/filters';
import { optimisticPatch, planMove } from '../src/renderer/views/task-board/moves';

const task = (id: string, status: TaskStatus, over: Partial<Task> = {}): Task =>
  ({
    id,
    status,
    label: `Label ${id}`,
    priority: 'P2',
    assignee: null,
    depends_on: [],
    blocked_from: null,
    updated_at: '2026-03-12T10:00:00.000Z',
    ...over,
  }) as Task;

const byId = (...tasks: Task[]) => new Map(tasks.map((t) => [t.id, t]));

describe('planMove: UI/UX §6.2 state-machine table', () => {
  const from = (status: TaskStatus, over: Partial<Task> = {}) => task('T1', status, over);

  it('todo -> in_progress starts directly', () => {
    const t = from('todo');
    expect(planMove(t, 'in_progress', byId(t))).toEqual({
      kind: 'direct',
      move: { trigger: 'start', payload: {} },
    });
  });

  it('todo -> in_progress with unmet dependencies asks to start anyway (force)', () => {
    const dep = task('D1', 'in_progress');
    const t = from('todo', { depends_on: ['D1', 'GONE'] });
    const plan = planMove(t, 'in_progress', byId(t, dep));
    expect(plan).toMatchObject({
      kind: 'confirm',
      move: { trigger: 'start', payload: { force: true } },
    });
    expect((plan as { body: string }).body).toContain('D1, GONE');
  });

  it('todo -> in_progress is direct when dependencies are done', () => {
    const dep = task('D1', 'done');
    const t = from('todo', { depends_on: ['D1'] });
    expect(planMove(t, 'in_progress', byId(t, dep)).kind).toBe('direct');
  });

  it('in_progress -> review offers an optional summary', () => {
    const t = from('in_progress');
    expect(planMove(t, 'review', byId(t))).toMatchObject({
      kind: 'summary',
      move: { trigger: 'complete' },
    });
  });

  it('review -> done approves directly', () => {
    const t = from('review');
    expect(planMove(t, 'done', byId(t))).toEqual({
      kind: 'direct',
      move: { trigger: 'approve', payload: {} },
    });
  });

  it('review -> in_progress requires a reject reason', () => {
    const t = from('review');
    expect(planMove(t, 'in_progress', byId(t))).toMatchObject({
      kind: 'reason',
      trigger: 'reject',
    });
  });

  it.each(['todo', 'in_progress', 'review'] as const)('%s -> blocked requires a reason', (s) => {
    const t = from(s);
    expect(planMove(t, 'blocked', byId(t))).toMatchObject({ kind: 'reason', trigger: 'block' });
  });

  it('blocked -> its previous status unblocks; any other column is illegal', () => {
    const t = from('blocked', { blocked_from: 'review' });
    expect(planMove(t, 'review', byId(t))).toEqual({
      kind: 'direct',
      move: { trigger: 'unblock', payload: {} },
    });
    expect(planMove(t, 'done', byId(t))).toMatchObject({ kind: 'illegal' });
    expect((planMove(t, 'todo', byId(t)) as { message: string }).message).toContain('Review');
  });

  it('blocked with no recorded previous status returns to todo', () => {
    const t = from('blocked');
    expect(planMove(t, 'todo', byId(t)).kind).toBe('direct');
  });

  it.each([
    ['todo', 'review', 'complete', 'Skip steps?'],
    ['todo', 'done', 'approve', 'Skip review?'],
    ['in_progress', 'done', 'approve', 'Skip review?'],
  ] as const)('%s -> %s asks to skip (confirm, skipSteps)', (a, b, trigger, title) => {
    const t = from(a);
    expect(planMove(t, b, byId(t))).toMatchObject({
      kind: 'confirm',
      title,
      move: { trigger, payload: { skipSteps: true } },
    });
  });

  it('is a no-op for the same column and illegal for backwards or out-of-done moves', () => {
    const t = from('review');
    expect(planMove(t, 'review', byId(t))).toEqual({ kind: 'noop' });
    expect(planMove(t, 'todo', byId(t)).kind).toBe('illegal');
    expect(planMove(from('in_progress'), 'todo', byId(t)).kind).toBe('illegal');
    for (const to of ['todo', 'in_progress', 'review', 'blocked'] as const) {
      expect(planMove(from('done'), to, byId(t)).kind).toBe('illegal');
    }
  });
});

describe('optimisticPatch', () => {
  it('predicts status and blocked bookkeeping', () => {
    const t = task('T1', 'in_progress');
    expect(optimisticPatch(t, { trigger: 'complete', payload: {} })).toEqual({ status: 'review' });
    expect(optimisticPatch(t, { trigger: 'block', payload: { reason: 'api' } })).toMatchObject({
      status: 'blocked',
      blocked_from: 'in_progress',
      blocked_reason: 'api',
    });
    const blocked = task('T2', 'blocked', { blocked_from: 'review' });
    expect(optimisticPatch(blocked, { trigger: 'unblock', payload: {} })).toMatchObject({
      status: 'review',
      blocked_from: null,
    });
  });
});

describe('filters', () => {
  const agents = new Map<string, Pick<Agent, 'type'>>([
    ['operator', { type: 'human' }],
    ['claude', { type: 'orchestrator' }],
  ]);
  const tasks = [
    task('T1', 'todo', { assignee: 'operator', priority: 'P0', label: 'Fix login' }),
    task('T2', 'blocked', { assignee: 'claude', priority: 'P1', label: 'Wire API' }),
    task('T3', 'review', { assignee: null, priority: 'P2', label: 'Docs' }),
  ];
  const ids = (f: Partial<typeof NO_FILTERS>) =>
    applyFilters(tasks, agents, { ...NO_FILTERS, ...f }).map((t) => t.id);

  it('segments', () => {
    expect(ids({})).toEqual(['T1', 'T2', 'T3']);
    expect(ids({ segment: 'mine' })).toEqual(['T1']);
    expect(ids({ segment: 'agent' })).toEqual(['T2']);
    expect(ids({ segment: 'blocked' })).toEqual(['T2']);
  });

  it('search matches id or label, case-insensitively', () => {
    expect(ids({ search: 'LOGIN' })).toEqual(['T1']);
    expect(ids({ search: 't3' })).toEqual(['T3']);
  });

  it('priority and assignee multi-select combine with AND across kinds', () => {
    expect(ids({ priorities: ['P0', 'P2'] })).toEqual(['T1', 'T3']);
    expect(ids({ assignees: [UNASSIGNED] })).toEqual(['T3']);
    expect(ids({ assignees: ['claude', UNASSIGNED], priorities: ['P1'] })).toEqual(['T2']);
  });

  it('orders by priority, then newest update, then id', () => {
    const a = task('A', 'todo', { priority: 'P1', updated_at: '2026-01-01T00:00:00Z' });
    const b = task('B', 'todo', { priority: 'P1', updated_at: '2026-02-01T00:00:00Z' });
    const c = task('C', 'todo', { priority: 'P0', updated_at: '2025-01-01T00:00:00Z' });
    expect([a, b, c].sort(compareTasks).map((t) => t.id)).toEqual(['C', 'B', 'A']);
  });
});

describe('mergeTracker structural sharing', () => {
  const base = (): TrackerState =>
    ({
      project: { id: 1, name: 'P' },
      milestones: [{ id: 'M1', title: 'm' }],
      subtasks: [task('T1', 'todo'), task('T2', 'todo')],
      agents: [{ id: 'a', name: 'a' }],
      agent_log: [{ id: 'l1', action: 'x' }],
      phases: [],
      lessons_learned: [{ id: 1, subtask_id: 'T1' }],
    }) as unknown as TrackerState;

  it('returns the previous object when nothing changed', () => {
    const prev = base();
    expect(mergeTracker(prev, base())).toBe(prev);
  });

  it('keeps references for unchanged rows and replaces only the changed one', () => {
    const prev = base();
    const next = base();
    next.subtasks[1] = task('T2', 'review');
    const merged = mergeTracker(prev, next);
    expect(merged).not.toBe(prev);
    expect(merged.subtasks[0]).toBe(prev.subtasks[0]);
    expect(merged.subtasks[1]).toBe(next.subtasks[1]);
    expect(merged.milestones).toBe(prev.milestones);
    expect(merged.agents).toBe(prev.agents);
    expect(merged.agent_log).toBe(prev.agent_log);
  });

  it('handles added and removed rows', () => {
    const prev = base();
    const next = base();
    next.subtasks.push(task('T3', 'todo'));
    expect(mergeTracker(prev, next).subtasks).toHaveLength(3);
    next.subtasks = next.subtasks.slice(1);
    const merged = mergeTracker(prev, next);
    expect(merged.subtasks.map((t) => t.id)).toEqual(['T2', 'T3']);
    expect(merged.subtasks[0]).toBe(prev.subtasks[1]);
  });
});

describe('time formatting', () => {
  const now = Date.parse('2026-03-12T12:00:00Z');
  it('relativeTime follows UI/UX §8', () => {
    expect(relativeTime('2026-03-12T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-03-12T11:57:00Z', now)).toBe('3m ago');
    expect(relativeTime('2026-03-12T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2025-12-25T12:00:00Z', now)).toMatch(/^Dec 2[45], 2025$/);
    expect(relativeTime('2026-03-01T12:00:00Z', now)).toMatch(/^Mar [12]$/);
  });
  it('elapsed is compact', () => {
    expect(elapsed('2026-03-12T11:59:40Z', now)).toBe('<1m');
    expect(elapsed('2026-03-12T11:18:00Z', now)).toBe('42m');
    expect(elapsed('2026-03-12T09:55:00Z', now)).toBe('2h 05m');
    expect(elapsed('2026-03-09T08:00:00Z', now)).toBe('3d 4h');
  });
});
