import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { IllegalTransitionError, MilestoneNotFoundError, TaskNotFoundError } from '../src/errors';
import { getActivityFeed, getTask } from '../src/queries';
import { transition } from '../src/state-machine';
import { createTask, getTaskHistory, updateTask } from '../src/tasks';
import { addTask, tmpDb } from './helpers';

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
});
afterEach(() => t.cleanup());

describe('skipSteps', () => {
  const skipCases = [
    ['todo', 'complete', 'review'],
    ['todo', 'approve', 'done'],
    ['in_progress', 'approve', 'done'],
  ] as const;

  for (const [from, trigger, to] of skipCases) {
    it(`${from} -> ${to} via ${trigger} only with skipSteps`, () => {
      addTask(t.db, 'T1', from);
      expect(() => transition(t.db, 'T1', trigger)).toThrow(IllegalTransitionError);
      const moved = transition(t.db, 'T1', trigger, { skipSteps: true });
      expect(moved.status).toBe(to);
      expect(getActivityFeed(t.db)[0]?.description).toContain('(steps skipped)');
    });
  }

  it('does not widen other triggers or non-skip paths', () => {
    addTask(t.db, 'T1', 'done');
    addTask(t.db, 'T2', 'todo');
    expect(() => transition(t.db, 'T1', 'approve', { skipSteps: true })).toThrow(
      IllegalTransitionError,
    );
    expect(() => transition(t.db, 'T2', 'reject', { skipSteps: true, reason: 'x' })).toThrow(
      IllegalTransitionError,
    );
  });

  it('does not mark a normal review -> done as skipped', () => {
    addTask(t.db, 'T1', 'review');
    transition(t.db, 'T1', 'approve', { skipSteps: true });
    expect(getActivityFeed(t.db)[0]?.description).not.toContain('skipped');
  });
});

describe('updateTask', () => {
  it('applies a validated patch, serializes JSON fields, bumps updated_at and logs it', () => {
    addTask(t.db, 'T1');
    const before = getTask(t.db, 'T1');
    const task = updateTask(t.db, 'T1', {
      label: '  New label ',
      priority: 'P0',
      constraints: ['a', 'b'],
      acceptance_criteria: [{ text: 'works', done: true }],
      assignee: 'operator',
    });
    expect(task).toMatchObject({
      label: 'New label',
      priority: 'P0',
      constraints: ['a', 'b'],
      acceptance_criteria: [{ text: 'works', done: true }],
      assignee: 'operator',
    });
    expect(task.updated_at).not.toBe(before?.updated_at);
    expect(getActivityFeed(t.db)[0]).toMatchObject({ action: 'task_updated', target_id: 'T1' });
  });

  it('rejects unknown fields (status must go through transition) and bad values', () => {
    addTask(t.db, 'T1');
    expect(() => updateTask(t.db, 'T1', { status: 'done' })).toThrow(ZodError);
    expect(() => updateTask(t.db, 'T1', { priority: 'P9' })).toThrow(ZodError);
    expect(() => updateTask(t.db, 'T1', { label: '   ' })).toThrow(ZodError);
    expect(getTask(t.db, 'T1')?.status).toBe('todo');
    expect(getActivityFeed(t.db)).toHaveLength(0);
  });

  it('throws for a missing task and logs nothing for an empty patch', () => {
    expect(() => updateTask(t.db, 'NOPE', { notes: 'x' })).toThrow(TaskNotFoundError);
    addTask(t.db, 'T1');
    updateTask(t.db, 'T1', {});
    expect(getActivityFeed(t.db)).toHaveLength(0);
  });
});

describe('createTask', () => {
  it('assigns the next TASK-### id, defaults to todo/P2, and logs it', () => {
    t.db.prepare("INSERT INTO milestones (id, title) VALUES ('M1', 'One')").run();
    addTask(t.db, 'TASK-007');
    const created = createTask(t.db, { milestoneId: 'M1', label: ' Write docs ' });
    expect(created).toMatchObject({
      id: 'TASK-008',
      milestone_id: 'M1',
      label: 'Write docs',
      status: 'todo',
      priority: 'P2',
    });
    expect(createTask(t.db, { milestoneId: 'M1', label: 'Next' }).id).toBe('TASK-009');
    expect(getActivityFeed(t.db).some((e) => e.action === 'task_created')).toBe(true);
  });

  it('starts at TASK-001 and rejects unknown milestones and blank labels', () => {
    t.db.prepare("INSERT INTO milestones (id, title) VALUES ('M1', 'One')").run();
    expect(createTask(t.db, { milestoneId: 'M1', label: 'first' }).id).toBe('TASK-001');
    expect(() => createTask(t.db, { milestoneId: 'NOPE', label: 'x' })).toThrow(
      MilestoneNotFoundError,
    );
    expect(() => createTask(t.db, { milestoneId: 'M1', label: ' ' })).toThrow(ZodError);
  });
});

describe('getTaskHistory', () => {
  it('returns only this task’s log entries (newest first) and its lessons', () => {
    addTask(t.db, 'T1');
    addTask(t.db, 'T2');
    transition(t.db, 'T1', 'start');
    transition(t.db, 'T1', 'complete');
    transition(t.db, 'T1', 'reject', { reason: 'Modal did not close' });
    transition(t.db, 'T2', 'start');
    const h = getTaskHistory(t.db, 'T1');
    expect(h.log.map((e) => e.action)).toEqual(['task_rejected', 'task_completed', 'task_started']);
    expect(h.log.every((e) => e.target_id === 'T1')).toBe(true);
    expect(h.lessons).toHaveLength(1);
    expect(h.lessons[0]?.rejection_reason).toBe('Modal did not close');
    expect(getTaskHistory(t.db, 'T2').lessons).toEqual([]);
  });
});
