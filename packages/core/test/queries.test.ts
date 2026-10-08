import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextString, buildTaskContextMd, currentWeek } from '../src/context';
import { addLesson, getRelevantLessons } from '../src/lessons';
import {
  getActivityFeed,
  getAllTrackerState,
  getMilestone,
  getTask,
  listAgents,
  listTasks,
} from '../src/queries';
import { seedDb } from '../src/seed';
import { addTask, tmpDb } from './helpers';

const NOW = new Date('2026-03-12T10:00:00Z');

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
});
afterEach(() => t.cleanup());

describe('seed', () => {
  it('produces the documented fixture and parses through every schema', () => {
    expect(seedDb(t.db, { now: NOW })).toEqual({
      milestones: 8,
      tasks: 60,
      agents: 4,
      logRows: 200,
    });
    const state = getAllTrackerState(t.db);
    expect(state.milestones).toHaveLength(8);
    expect(state.subtasks).toHaveLength(60);
    expect(state.agents).toHaveLength(6); // 4 seeded + operator + system
    expect(state.agent_log).toHaveLength(200);
    expect(state.phases).toHaveLength(3);
    expect(new Set(state.milestones.map((m) => m.domain))).toEqual(
      new Set(['Platform', 'Product', 'Infra']),
    );
    expect(state.milestones.filter((m) => m.drift_days !== 0).length).toBeGreaterThan(0);
    const statuses = new Set(state.subtasks.map((s) => s.status));
    expect(statuses).toEqual(new Set(['todo', 'in_progress', 'review', 'done', 'blocked']));
  });

  it('is deterministic for the same now and seed', () => {
    const other = tmpDb();
    seedDb(t.db, { now: NOW });
    seedDb(other.db, { now: NOW });
    // Log ids are random UUIDs; everything else must match.
    const strip = (db: typeof t.db) => {
      const s = getAllTrackerState(db);
      return { ...s, agent_log: s.agent_log.map((e) => ({ ...e, id: '' })) };
    };
    expect(strip(t.db)).toEqual(strip(other.db));
    other.cleanup();
  });
});

describe('queries', () => {
  beforeEach(() => {
    seedDb(t.db, { now: NOW });
  });

  it('maps JSON columns to real arrays', () => {
    const task = getTask(t.db, 'TASK-001');
    expect(Array.isArray(task?.acceptance_criteria)).toBe(true);
    expect(task?.acceptance_criteria[0]).toHaveProperty('text');
    expect(getMilestone(t.db, 'M4')?.dependencies).toEqual(['M2', 'M3']);
    expect(getMilestone(t.db, 'M4')?.is_key_milestone).toBe(true);
    expect(getMilestone(t.db, 'NOPE')).toBeNull();
  });

  it('filters tasks', () => {
    expect(listTasks(t.db, { milestoneId: 'M1' })).toHaveLength(8);
    const blocked = listTasks(t.db, { status: 'blocked' });
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((x) => x.status === 'blocked' && x.blocked_from === 'in_progress')).toBe(
      true,
    );
    expect(listTasks(t.db, { status: ['review', 'blocked'] }).length).toBeGreaterThan(
      blocked.length,
    );
    expect(listTasks(t.db, { search: 'task-007' })).toHaveLength(1);
  });

  it('pages the activity feed with a cursor and no overlap', () => {
    const page1 = getActivityFeed(t.db, { limit: 80 });
    const last = page1[page1.length - 1];
    if (!last) throw new Error('empty page');
    const page2 = getActivityFeed(t.db, {
      limit: 80,
      before: { timestamp: last.timestamp, id: last.id },
    });
    const ids = new Set(page1.map((e) => e.id));
    expect(page2.some((e) => ids.has(e.id))).toBe(false);
    expect((page1[0]?.timestamp ?? '') >= (page2[0]?.timestamp ?? '')).toBe(true);
    expect(
      getActivityFeed(t.db, { agentId: 'claude-code' }).every((e) => e.agent_id === 'claude-code'),
    ).toBe(true);
  });

  it('tracks per-agent activity counters from logged rows', () => {
    const total = listAgents(t.db).reduce((n, a) => n + a.session_action_count, 0);
    expect(total).toBe(200);
  });
});

describe('context', () => {
  it('currentWeek is 1-based and clamped', () => {
    expect(currentWeek('2026-01-05', new Date('2026-01-05T00:00:00Z'))).toBe(1);
    expect(currentWeek('2026-01-05', new Date('2026-01-12T00:00:00Z'))).toBe(2);
    expect(currentWeek('2026-01-05', new Date('2025-12-01T00:00:00Z'))).toBe(1);
  });

  it('builds the one-line context string from live data', () => {
    seedDb(t.db, { now: NOW });
    expect(buildContextString(t.db, NOW)).toMatch(
      /^WEEK 7, Phase: Build, Progress: \d+%, Schedule: at_risk, Blocked: [1-9]\d*$/,
    );
  });

  it('builds TASK_CONTEXT.md with all six sections, including relevant lessons', () => {
    addTask(t.db, 'T1', 'todo', { label: 'Build modal dialog' });
    addTask(t.db, 'T0', 'review', { label: 'Old modal work' });
    addLesson(t.db, 'T0', 'Modal did not close on backdrop click', 'Added target check');
    const md = buildTaskContextMd(t.db, 'T1', NOW) ?? '';
    for (const h of [
      'Task description',
      'Acceptance criteria',
      'Context files',
      'Reference docs',
      'Constraints',
      'Relevant lessons',
    ]) {
      expect(md).toContain(`## ${h}`);
    }
    expect(md).toContain('Modal did not close on backdrop click — fix: Added target check');
    expect(buildTaskContextMd(t.db, 'NOPE')).toBeNull();
  });
});

describe('lessons retrieval', () => {
  beforeEach(() => {
    addTask(t.db, 'T0', 'review');
  });

  it('ranks by FTS match, limits to 5, and returns nothing for unrelated labels', () => {
    for (let i = 0; i < 7; i++) addLesson(t.db, 'T0', `Pagination bug ${i}`, 'Fixed offset');
    addLesson(t.db, 'T0', 'Dropdown clipped by container', 'Used portal');
    expect(getRelevantLessons(t.db, 'Paginate results')).toHaveLength(0); // "paginate" is not a prefix of "pagination"
    expect(getRelevantLessons(t.db, 'Pagination of tasks')).toHaveLength(5);
    expect(getRelevantLessons(t.db, 'Dropdown menu')[0]?.fix_applied).toBe('Used portal');
    expect(getRelevantLessons(t.db, 'Zebra')).toEqual([]);
    expect(getRelevantLessons(t.db, 'a')).toEqual([]);
  });

  it('falls back to LIKE for substring matches FTS misses, and tracks deletes', () => {
    const id = addLesson(t.db, 'T0', 'Overflowing sidebar layout', 'Set min-width');
    expect(getRelevantLessons(t.db, 'flowing')[0]?.id).toBe(id);
    t.db.prepare('DELETE FROM lessons_learned WHERE id = ?').run(id);
    expect(getRelevantLessons(t.db, 'Overflowing')).toEqual([]);
  });
});
