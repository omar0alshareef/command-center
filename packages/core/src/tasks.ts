import { z } from 'zod';
import { nowIso, write, type Db } from './db';
import { MilestoneNotFoundError, TaskNotFoundError } from './errors';
import { getActivityFeed, getMilestone, getTask, logAction } from './queries';
import {
  AcceptanceCriterionSchema,
  LessonSchema,
  PRIORITIES,
  toJson,
  type AgentLogEntry,
  type Lesson,
  type Task,
} from './types';

/** Fields a caller may edit directly. Status changes go through `transition()` only. */
export const TaskPatchSchema = z
  .object({
    label: z.string().trim().min(1),
    notes: z.string().nullable(),
    priority: z.enum(PRIORITIES),
    assignee: z.string().nullable(),
    prompt: z.string().nullable(),
    builder_prompt: z.string().nullable(),
    agent_target: z.string().nullable(),
    execution_mode: z.string().min(1),
    context_files: z.array(z.string()),
    reference_docs: z.array(z.string()),
    constraints: z.array(z.string()),
    depends_on: z.array(z.string()),
    acceptance_criteria: z.array(AcceptanceCriterionSchema),
  })
  .partial()
  .strict();
export type TaskPatch = z.infer<typeof TaskPatchSchema>;

const JSON_FIELDS = new Set([
  'context_files',
  'reference_docs',
  'constraints',
  'depends_on',
  'acceptance_criteria',
]);

/** Validate and apply a field edit. Logs one `task_updated` entry naming the changed fields. */
export function updateTask(db: Db, taskId: string, rawPatch: unknown, actor = 'operator'): Task {
  const patch = TaskPatchSchema.parse(rawPatch);
  const fields = Object.keys(patch) as (keyof TaskPatch)[];
  return write(db, () => {
    if (!getTask(db, taskId)) throw new TaskNotFoundError(taskId);
    if (fields.length > 0) {
      const now = nowIso();
      const sets = fields.map((f) => `${f} = @${f}`).join(', ');
      const params: Record<string, unknown> = { id: taskId, now };
      for (const f of fields) {
        const v = patch[f];
        params[f] = JSON_FIELDS.has(f) ? toJson(v as unknown[]) : v;
      }
      db.prepare(`UPDATE subtasks SET ${sets}, updated_at = @now WHERE id = @id`).run(params);
      logAction(db, {
        agentId: actor,
        action: 'task_updated',
        targetType: 'subtask',
        targetId: taskId,
        description: `${taskId}: edited ${fields.join(', ')}`,
        tags: ['edit'],
        at: now,
      });
    }
    const updated = getTask(db, taskId);
    if (!updated) throw new TaskNotFoundError(taskId);
    return updated;
  });
}

export interface NewTask {
  milestoneId: string;
  label: string;
  priority?: (typeof PRIORITIES)[number];
  assignee?: string | null;
}

/** Create a `todo` task with the next free `TASK-###` id. */
export function createTask(db: Db, input: NewTask, actor = 'operator'): Task {
  const label = z.string().trim().min(1).parse(input.label);
  const priority = z.enum(PRIORITIES).default('P2').parse(input.priority);
  return write(db, () => {
    if (!getMilestone(db, input.milestoneId)) throw new MilestoneNotFoundError(input.milestoneId);
    const row = db
      .prepare(
        "SELECT MAX(CAST(SUBSTR(id, 6) AS INTEGER)) AS n FROM subtasks WHERE id GLOB 'TASK-[0-9]*'",
      )
      .get() as { n: number | null };
    const id = `TASK-${String((row.n ?? 0) + 1).padStart(3, '0')}`;
    const now = nowIso();
    db.prepare(
      `INSERT INTO subtasks (id, milestone_id, label, priority, assignee, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.milestoneId, label, priority, input.assignee ?? null, now, now);
    logAction(db, {
      agentId: actor,
      action: 'task_created',
      targetType: 'subtask',
      targetId: id,
      description: `${id}: created in ${input.milestoneId} — ${label}`,
      tags: ['create'],
      at: now,
    });
    const created = getTask(db, id);
    if (!created) throw new TaskNotFoundError(id);
    return created;
  });
}

export interface TaskHistory {
  log: AgentLogEntry[];
  lessons: Lesson[];
}

/** Everything that happened to one task: its log entries (newest first) and rejection lessons. */
export function getTaskHistory(db: Db, taskId: string, limit = 200): TaskHistory {
  return {
    log: getActivityFeed(db, { targetId: taskId, limit }),
    lessons: LessonSchema.array().parse(
      db
        .prepare(
          'SELECT * FROM lessons_learned WHERE subtask_id = ? ORDER BY created_at DESC, id DESC',
        )
        .all(taskId),
    ),
  };
}
