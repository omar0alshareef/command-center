import { z } from 'zod';
import { nowIso, write, type Db } from './db';
import { AgentNotFoundError, MilestoneNotFoundError, TaskNotFoundError } from './errors';
import { isoDate } from './milestones';
import { getActivityFeed, getAgent, getMilestone, getTask, logAction } from './queries';
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
    /** Optional deadline (D16), YYYY-MM-DD. */
    due_date: isoDate.nullable(),
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

interface PatchLog {
  action: string;
  tag: string;
}

/** Validate references, write the columns, bump updated_at and log. Caller owns the transaction. */
function applyPatch(db: Db, taskId: string, patch: TaskPatch, actor: string, log: PatchLog): Task {
  const fields = Object.keys(patch) as (keyof TaskPatch)[];
  if (!getTask(db, taskId)) throw new TaskNotFoundError(taskId);
  if (patch.assignee && !getAgent(db, patch.assignee)) throw new AgentNotFoundError(patch.assignee);
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
      action: log.action,
      targetType: 'subtask',
      targetId: taskId,
      description: `${taskId}: edited ${fields.join(', ')}`,
      tags: [log.tag],
      at: now,
    });
  }
  const updated = getTask(db, taskId);
  if (!updated) throw new TaskNotFoundError(taskId);
  return updated;
}

/** Validate and apply a field edit. Logs one `task_updated` entry naming the changed fields. */
export function updateTask(db: Db, taskId: string, rawPatch: unknown, actor = 'operator'): Task {
  const patch = TaskPatchSchema.parse(rawPatch);
  return write(db, () =>
    applyPatch(db, taskId, patch, actor, { action: 'task_updated', tag: 'edit' }),
  );
}

const EnrichSchema = z
  .object({
    prompt: z.string().nullable(),
    builder_prompt: z.string().nullable(),
    notes: z.string().nullable(),
    acceptance_criteria: z.array(z.union([z.string().trim().min(1), AcceptanceCriterionSchema])),
    context_files: z.array(z.string()),
    reference_docs: z.array(z.string()),
    constraints: z.array(z.string()),
    depends_on: z.array(z.string()),
  })
  .partial()
  .strict();

const union = (a: readonly string[], b: readonly string[] | undefined): string[] => [
  ...new Set([...a, ...(b ?? [])]),
];

/**
 * Add context to a task without clobbering it: lists are unioned (acceptance criteria by text, keeping
 * existing done flags), `prompt` / `builder_prompt` / `notes` are replaced when provided.
 */
export function enrichTask(db: Db, taskId: string, rawInput: unknown, actor = 'operator'): Task {
  const input = EnrichSchema.parse(rawInput);
  return write(db, () => {
    const task = getTask(db, taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    const patch: TaskPatch = {};
    if (input.prompt !== undefined) patch.prompt = input.prompt;
    if (input.builder_prompt !== undefined) patch.builder_prompt = input.builder_prompt;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.context_files) patch.context_files = union(task.context_files, input.context_files);
    if (input.reference_docs)
      patch.reference_docs = union(task.reference_docs, input.reference_docs);
    if (input.constraints) patch.constraints = union(task.constraints, input.constraints);
    if (input.depends_on) patch.depends_on = union(task.depends_on, input.depends_on);
    if (input.acceptance_criteria) {
      const known = new Set(task.acceptance_criteria.map((c) => c.text));
      const added = input.acceptance_criteria
        .map((c) => (typeof c === 'string' ? { text: c, done: false } : c))
        .filter((c) => !known.has(c.text));
      patch.acceptance_criteria = [...task.acceptance_criteria, ...added];
    }
    return applyPatch(db, taskId, patch, actor, { action: 'task_enriched', tag: 'enrich' });
  });
}

export interface NewTask {
  milestoneId: string;
  label: string;
  priority?: (typeof PRIORITIES)[number];
  assignee?: string | null;
  /** Any other editable field (notes, prompt, acceptance_criteria, ...), applied in the same transaction. */
  fields?: Omit<TaskPatch, 'label' | 'priority' | 'assignee'>;
}

/** Create a `todo` task with the next free `TASK-###` id. */
export function createTask(db: Db, input: NewTask, actor = 'operator'): Task {
  const label = z.string().trim().min(1).parse(input.label);
  const priority = z.enum(PRIORITIES).default('P2').parse(input.priority);
  const fields = TaskPatchSchema.omit({ label: true, priority: true, assignee: true }).parse(
    input.fields ?? {},
  );
  return write(db, () => {
    if (!getMilestone(db, input.milestoneId)) throw new MilestoneNotFoundError(input.milestoneId);
    if (input.assignee && !getAgent(db, input.assignee))
      throw new AgentNotFoundError(input.assignee);
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
    const extra = Object.keys(fields) as (keyof typeof fields)[];
    if (extra.length > 0) {
      const params: Record<string, unknown> = { id };
      for (const f of extra)
        params[f] = JSON_FIELDS.has(f) ? toJson(fields[f] as unknown[]) : fields[f];
      db.prepare(
        `UPDATE subtasks SET ${extra.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`,
      ).run(params);
    }
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

/** Permanently delete a task and its lessons. Keeps its log entries and logs a `task_deleted` entry. */
export function deleteTask(db: Db, taskId: string, actor = 'operator'): Task {
  return write(db, () => {
    const task = getTask(db, taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    db.prepare('DELETE FROM lessons_learned WHERE subtask_id = ?').run(taskId);
    db.prepare('DELETE FROM subtasks WHERE id = ?').run(taskId);
    logAction(db, {
      agentId: actor,
      action: 'task_deleted',
      targetType: 'subtask',
      targetId: taskId,
      description: `${taskId}: deleted — ${task.label}`,
      tags: ['delete'],
    });
    return task;
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
