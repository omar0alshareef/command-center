import {
  buildTaskContextMd,
  CoreError,
  createTask,
  deleteTask,
  getTaskHistory,
  PRIORITIES,
  TRANSITION_RULES,
  transition,
  updateTask,
  type Db,
  type Task,
  type TaskHistory,
} from '@command-center/core';
import { z, ZodError } from 'zod';
import type { Result, TransitionRequest } from '../shared/ipc';

// Validation + error mapping for renderer-initiated task mutations. Everything routes through core,
// so the state machine and logging apply. The actor is always the human operator.

const ACTOR = 'operator';

const TransitionRequestSchema = z.object({
  taskId: z.string().min(1),
  trigger: z.enum(Object.keys(TRANSITION_RULES) as [keyof typeof TRANSITION_RULES]),
  payload: z
    .object({
      reason: z.string().optional(),
      summary: z.string().optional(),
      blockedBy: z.string().optional(),
      force: z.boolean().optional(),
      skipSteps: z.boolean().optional(),
    })
    .strict()
    .optional(),
});

const NewTaskSchema = z.object({
  milestoneId: z.string().min(1),
  label: z.string(),
  priority: z.enum(PRIORITIES).optional(),
  assignee: z.string().nullable().optional(),
});

function toError(e: unknown): Result<never> {
  if (e instanceof CoreError) return { ok: false, error: { code: e.code, message: e.message } };
  if (e instanceof ZodError) {
    const message = e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return { ok: false, error: { code: 'INVALID_INPUT', message } };
  }
  return {
    ok: false,
    error: { code: 'ERROR', message: e instanceof Error ? e.message : String(e) },
  };
}

export function run<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return toError(e);
  }
}

export function taskApi(getDb: () => Db) {
  return {
    transition: (req: unknown): Result<Task> =>
      run(() => {
        const r = TransitionRequestSchema.parse(req) as TransitionRequest;
        return transition(getDb(), r.taskId, r.trigger, { ...r.payload, actor: ACTOR });
      }),
    update: (req: unknown): Result<Task> =>
      run(() => {
        const { taskId, patch } = z
          .object({ taskId: z.string().min(1), patch: z.unknown() })
          .parse(req);
        return updateTask(getDb(), taskId, patch, ACTOR);
      }),
    create: (req: unknown): Result<Task> =>
      run(() => createTask(getDb(), NewTaskSchema.parse(req), ACTOR)),
    delete: (taskId: unknown): Result<Task> =>
      run(() => deleteTask(getDb(), z.string().min(1).parse(taskId), ACTOR)),
    history: (taskId: unknown): Result<TaskHistory> =>
      run(() => getTaskHistory(getDb(), z.string().min(1).parse(taskId))),
    contextMd: (taskId: unknown): Result<string | null> =>
      run(() => buildTaskContextMd(getDb(), z.string().min(1).parse(taskId))),
  };
}
