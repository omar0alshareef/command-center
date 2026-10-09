import { afterEach, beforeEach, expect, it } from 'vitest';
import { TaskNotFoundError } from '../src/errors';
import { getTask } from '../src/queries';
import { addLesson } from '../src/lessons';
import { deleteTask } from '../src/tasks';
import { addTask, tmpDb } from './helpers';

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
});
afterEach(() => t.cleanup());

it('deletes a task with its lessons and logs it', () => {
  addTask(t.db, 'TASK-001');
  addLesson(t.db, 'TASK-001', 'x');
  expect(deleteTask(t.db, 'TASK-001').id).toBe('TASK-001');
  expect(getTask(t.db, 'TASK-001')).toBeNull();
  const n = t.db.prepare("SELECT COUNT(*) AS n FROM agent_log WHERE action = 'task_deleted'").get() as {
    n: number;
  };
  expect(n.n).toBe(1);
});

it('throws for an unknown task', () => {
  expect(() => deleteTask(t.db, 'TASK-999')).toThrow(TaskNotFoundError);
});
