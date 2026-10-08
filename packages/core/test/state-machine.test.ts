import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DependenciesIncompleteError,
  IllegalTransitionError,
  ReasonRequiredError,
  TaskNotFoundError,
} from '../src/errors';
import { getRelevantLessons } from '../src/lessons';
import { getActivityFeed, getTask } from '../src/queries';
import { TRANSITION_RULES, transition, type Trigger } from '../src/state-machine';
import { TASK_STATUSES, type TaskStatus } from '../src/types';
import { addTask, tmpDb } from './helpers';

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
});
afterEach(() => t.cleanup());

const TRIGGERS = Object.keys(TRANSITION_RULES) as Trigger[];
const payloadFor = (trigger: Trigger) =>
  trigger === 'block' || trigger === 'reject' ? { reason: 'because' } : {};

// Expected target for each trigger. unblock is covered separately (restores previous status).
const TARGET: Record<Exclude<Trigger, 'unblock'>, TaskStatus> = {
  start: 'in_progress',
  complete: 'review',
  approve: 'done',
  reject: 'in_progress',
  block: 'blocked',
  reset: 'todo',
};

describe('transition rules', () => {
  for (const trigger of TRIGGERS.filter((x): x is Exclude<Trigger, 'unblock'> => x !== 'unblock')) {
    for (const from of TRANSITION_RULES[trigger]) {
      it(`${trigger}: ${from} -> ${TARGET[trigger]}`, () => {
        addTask(t.db, 'T1', from);
        expect(transition(t.db, 'T1', trigger, payloadFor(trigger)).status).toBe(TARGET[trigger]);
      });
    }
  }

  for (const trigger of TRIGGERS) {
    const allowed: readonly TaskStatus[] = TRANSITION_RULES[trigger];
    for (const from of TASK_STATUSES.filter((s) => !allowed.includes(s))) {
      it(`${trigger} from ${from} is illegal and changes nothing`, () => {
        addTask(t.db, 'T1', from);
        const before = getTask(t.db, 'T1');
        expect(() => transition(t.db, 'T1', trigger, payloadFor(trigger))).toThrow(
          IllegalTransitionError,
        );
        expect(getTask(t.db, 'T1')).toEqual(before);
        expect(getActivityFeed(t.db)).toHaveLength(0);
      });
    }
  }

  it('throws TaskNotFoundError for an unknown task', () => {
    expect(() => transition(t.db, 'NOPE', 'start')).toThrow(TaskNotFoundError);
  });
});

describe('block / unblock', () => {
  for (const from of ['todo', 'in_progress', 'review'] as const) {
    it(`restores ${from} after block + unblock`, () => {
      addTask(t.db, 'T1', from);
      const blocked = transition(t.db, 'T1', 'block', { reason: 'waiting on API' });
      expect(blocked).toMatchObject({
        status: 'blocked',
        blocked_from: from,
        blocked_by: 'manual',
        blocked_reason: 'waiting on API',
      });
      expect(transition(t.db, 'T1', 'unblock')).toMatchObject({
        status: from,
        blocked_from: null,
        blocked_by: null,
        blocked_reason: null,
      });
    });
  }

  it('unblocks to todo when no previous status was recorded', () => {
    addTask(t.db, 'T1', 'blocked');
    expect(transition(t.db, 'T1', 'unblock').status).toBe('todo');
  });

  it('requires a reason for block and reject, rejecting blank ones', () => {
    addTask(t.db, 'T1', 'in_progress');
    addTask(t.db, 'T2', 'review');
    expect(() => transition(t.db, 'T1', 'block')).toThrow(ReasonRequiredError);
    expect(() => transition(t.db, 'T2', 'reject', { reason: '   ' })).toThrow(ReasonRequiredError);
    expect(getTask(t.db, 'T1')?.status).toBe('in_progress');
  });
});

describe('side effects', () => {
  it('approve marks done with completed_at and completed_by (assignee wins over actor)', () => {
    addTask(t.db, 'T1', 'review', { assignee: 'claude-code' });
    t.db
      .prepare(
        "INSERT INTO agents (id, name, type) VALUES ('claude-code', 'claude-code', 'orchestrator')",
      )
      .run();
    const done = transition(t.db, 'T1', 'approve');
    expect(done).toMatchObject({ status: 'done', done: true, completed_by: 'claude-code' });
    expect(done.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('start sets last_run_id; reset clears completion and run state', () => {
    addTask(t.db, 'T1', 'todo');
    expect(transition(t.db, 'T1', 'start').last_run_id).toBeTruthy();
    const reset = transition(t.db, 'T1', 'reset');
    expect(reset).toMatchObject({ status: 'todo', last_run_id: null, done: false });
  });

  it('reject writes a lessons_learned row that FTS can find', () => {
    addTask(t.db, 'T1', 'review', { label: 'Build modal dialog' });
    transition(t.db, 'T1', 'reject', { reason: 'The modal did not close on backdrop click' });
    const rows = t.db.prepare('SELECT * FROM lessons_learned').all();
    expect(rows).toHaveLength(1);
    expect(getRelevantLessons(t.db, 'Fix modal focus')[0]?.subtask_id).toBe('T1');
  });

  it('every transition writes an agent_log row and bumps updated_at', () => {
    addTask(t.db, 'T1', 'todo');
    const before = getTask(t.db, 'T1')?.updated_at;
    transition(t.db, 'T1', 'start', { actor: 'system' });
    transition(t.db, 'T1', 'complete', { summary: 'done it' });
    const feed = getActivityFeed(t.db);
    expect(feed.map((e) => e.action).sort()).toEqual(['task_completed', 'task_started']);
    expect(feed.find((e) => e.action === 'task_completed')?.description).toContain('done it');
    expect(getTask(t.db, 'T1')?.updated_at).not.toBe(before);
    expect(
      t.db.prepare("SELECT session_action_count n FROM agents WHERE id = 'system'").get(),
    ).toEqual({ n: 1 });
  });

  it('rolls back everything when the actor is not a registered agent', () => {
    addTask(t.db, 'T1', 'todo');
    expect(() => transition(t.db, 'T1', 'start', { actor: 'ghost' })).toThrow();
    expect(getTask(t.db, 'T1')?.status).toBe('todo');
    expect(getActivityFeed(t.db)).toHaveLength(0);
  });
});

describe('dependencies', () => {
  it('blocks start while depends_on tasks are unfinished, unless forced', () => {
    addTask(t.db, 'DEP', 'in_progress');
    addTask(t.db, 'T1', 'todo', { depends_on: ['DEP', 'MISSING'] });
    const err = (() => {
      try {
        transition(t.db, 'T1', 'start');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(DependenciesIncompleteError);
    expect((err as DependenciesIncompleteError).unmet).toEqual(['DEP', 'MISSING']);
    expect(transition(t.db, 'T1', 'start', { force: true }).status).toBe('in_progress');
  });

  it('allows start once dependencies are done', () => {
    addTask(t.db, 'DEP', 'done');
    addTask(t.db, 'T1', 'todo', { depends_on: ['DEP'] });
    expect(transition(t.db, 'T1', 'start').status).toBe('in_progress');
  });
});
