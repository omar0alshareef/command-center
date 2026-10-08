import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { registerAgent } from '../src/agents';
import { buildTaskContextMd } from '../src/context';
import { AgentNotFoundError, TaskNotFoundError } from '../src/errors';
import { createMilestone } from '../src/milestones';
import { getMilestoneOverview, getProjectStatus, getTaskSummary } from '../src/overview';
import { getActivityFeed, getTask } from '../src/queries';
import { seedDb } from '../src/seed';
import { transition } from '../src/state-machine';
import { createTask, enrichTask, updateTask } from '../src/tasks';
import { capTokens, estimateTokens } from '../src/tokens';
import { addTask, tmpDb } from './helpers';

const NOW = new Date('2026-03-12T10:00:00Z');
let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
});
afterEach(() => t.cleanup());

describe('capTokens', () => {
  it('returns short text untouched', () => {
    expect(capTokens('hello', 100, 'more')).toEqual({
      text: 'hello',
      truncated: false,
      originalTokens: 2,
    });
  });

  it('truncates long text at a line boundary, adds a notice, and stays within budget', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}: ${'x'.repeat(40)}`).join('\n');
    const capped = capTokens(text, 500, 'Call get_task_history for more.');
    expect(capped.truncated).toBe(true);
    expect(capped.originalTokens).toBeGreaterThan(500);
    expect(estimateTokens(capped.text)).toBeLessThanOrEqual(500);
    expect(capped.text).toMatch(
      /\[truncated: ~\d+ of ~\d+ tokens omitted to fit a 500-token budget\. Call get_task_history for more\.\]$/,
    );
    expect(capped.text.startsWith('line 0:')).toBe(true);
    // Cut on a line boundary: the last kept line is complete.
    const kept = capped.text.split('\n\n[truncated')[0] ?? '';
    expect(kept.endsWith('x'.repeat(40))).toBe(true);
  });

  it('handles a budget too small for the notice without throwing', () => {
    expect(capTokens('y'.repeat(1000), 5, 'more').truncated).toBe(true);
  });
});

describe('createTask extras and assignee validation', () => {
  beforeEach(() => {
    createMilestone(t.db, { title: 'One' }, 'operator');
    registerAgent(t.db, { id: 'bot', name: 'Bot', type: 'orchestrator' });
  });

  it('applies extra fields in the same transaction with one log row', () => {
    const task = createTask(
      t.db,
      {
        milestoneId: 'M1',
        label: 'Wire it',
        priority: 'P1',
        assignee: 'bot',
        fields: {
          notes: 'n',
          acceptance_criteria: [{ text: 'works', done: false }],
          context_files: ['a.ts'],
        },
      },
      'bot',
    );
    expect(task).toMatchObject({
      priority: 'P1',
      assignee: 'bot',
      notes: 'n',
      context_files: ['a.ts'],
      acceptance_criteria: [{ text: 'works', done: false }],
    });
    expect(getActivityFeed(t.db).filter((e) => e.target_id === task.id)).toHaveLength(1);
  });

  it('rejects unknown assignees (create and update) and unknown extra fields', () => {
    expect(() => createTask(t.db, { milestoneId: 'M1', label: 'x', assignee: 'ghost' })).toThrow(
      AgentNotFoundError,
    );
    const task = createTask(t.db, { milestoneId: 'M1', label: 'x' });
    expect(() => updateTask(t.db, task.id, { assignee: 'ghost' })).toThrow(AgentNotFoundError);
    expect(updateTask(t.db, task.id, { assignee: 'bot' }).assignee).toBe('bot');
    expect(updateTask(t.db, task.id, { assignee: null }).assignee).toBeNull();
    expect(() =>
      createTask(t.db, { milestoneId: 'M1', label: 'x', fields: { status: 'done' } as never }),
    ).toThrow(ZodError);
    expect(getTask(t.db, task.id)?.status).toBe('todo');
  });
});

describe('enrichTask', () => {
  it('unions lists, dedupes criteria by text keeping done flags, replaces prompt, logs task_enriched', () => {
    addTask(t.db, 'T1');
    updateTask(t.db, 'T1', {
      context_files: ['a.ts'],
      acceptance_criteria: [{ text: 'A', done: true }],
      constraints: ['no deps'],
    });
    const out = enrichTask(t.db, 'T1', {
      prompt: 'Do the thing',
      context_files: ['a.ts', 'b.ts'],
      acceptance_criteria: ['A', 'B', { text: 'C', done: true }],
      constraints: ['no deps', 'strict'],
      reference_docs: ['SPEC.md'],
    });
    expect(out.prompt).toBe('Do the thing');
    expect(out.context_files).toEqual(['a.ts', 'b.ts']);
    expect(out.constraints).toEqual(['no deps', 'strict']);
    expect(out.reference_docs).toEqual(['SPEC.md']);
    expect(out.acceptance_criteria).toEqual([
      { text: 'A', done: true },
      { text: 'B', done: false },
      { text: 'C', done: true },
    ]);
    expect(getActivityFeed(t.db)[0]).toMatchObject({ action: 'task_enriched', target_id: 'T1' });
  });

  it('errors for a missing task, rejects unknown keys, and an empty enrich changes and logs nothing', () => {
    expect(() => enrichTask(t.db, 'NOPE', { prompt: 'x' })).toThrow(TaskNotFoundError);
    addTask(t.db, 'T1');
    expect(() => enrichTask(t.db, 'T1', { status: 'done' })).toThrow(ZodError);
    const before = getActivityFeed(t.db).length;
    enrichTask(t.db, 'T1', {});
    expect(getActivityFeed(t.db)).toHaveLength(before);
  });
});

describe('overview read models', () => {
  beforeEach(() => {
    seedDb(t.db, { now: NOW });
  });

  it('getProjectStatus summarizes progress, blocked and review', () => {
    const s = getProjectStatus(t.db, NOW);
    expect(s).toMatchObject({
      name: 'Demo Project',
      week: 7,
      phase: 'Build',
      total_tasks: 60,
      schedule_status: 'at_risk',
    });
    expect(Object.values(s.tasks).reduce((a, b) => a + b, 0)).toBe(60);
    expect(s.blocked.length).toBe(s.tasks.blocked);
    expect(s.awaiting_review.length).toBe(s.tasks.review);
    expect(s.context).toMatch(/^WEEK 7, Phase: Build,/);
    expect(s.max_drift_days).toBe(5);
    expect(s.agents.total).toBe(6);
  });

  it('getMilestoneOverview returns all or one milestone with task progress', () => {
    const all = getMilestoneOverview(t.db);
    expect(all).toHaveLength(8);
    const m4 = getMilestoneOverview(t.db, 'M4')[0];
    expect(m4).toMatchObject({
      id: 'M4',
      key_milestone: 'Beta Release',
      dependencies: ['M2', 'M3'],
      drift_days: 5,
    });
    expect(m4?.progress.total).toBe(8);
    expect(m4?.progress.done).toBe(m4?.progress.by_status.done);
    expect(getMilestoneOverview(t.db, 'NOPE')).toEqual([]);
  });

  it('getTaskSummary is compact and shows dependency status and last event', () => {
    transition(t.db, 'TASK-060', 'start', { force: true });
    const s = getTaskSummary(t.db, 'TASK-060');
    expect(s).toMatchObject({ id: 'TASK-060', status: 'in_progress', milestone: { id: 'M8' } });
    expect(s?.last_event).toMatchObject({ action: 'task_started', agent: 'operator' });
    expect(JSON.stringify(s).length / 4).toBeLessThan(500);
    expect(getTaskSummary(t.db, 'NOPE')).toBeNull();
  });

  it('the full task context grows with the task but is cappable to the 8K budget', () => {
    updateTask(t.db, 'TASK-001', { notes: 'long '.repeat(20_000) });
    const md = buildTaskContextMd(t.db, 'TASK-001', NOW) ?? '';
    expect(estimateTokens(md)).toBeGreaterThan(8000);
    const capped = capTokens(md, 8000, 'Use get_task_summary for a short version.');
    expect(capped.truncated).toBe(true);
    expect(estimateTokens(capped.text)).toBeLessThanOrEqual(8000);
  });
});
