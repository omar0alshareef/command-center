import { z } from 'zod';

// Row schemas validate what comes out of SQLite and map JSON-in-TEXT columns to real arrays (D14).
// Nothing outside this file parses or stringifies those columns.

export const TASK_STATUSES = ['todo', 'in_progress', 'review', 'done', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

const bool = z.number().transform((n) => n !== 0);

function jsonArray<T extends z.ZodType>(item: T) {
  return z
    .string()
    .nullable()
    .transform((s, ctx) => {
      if (s === null) return [] as unknown[];
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.issues.push({ code: 'custom', message: 'Invalid JSON in column', input: s });
        return z.NEVER;
      }
    })
    .pipe(z.array(item));
}

export function toJson(value: unknown[]): string {
  return JSON.stringify(value);
}

export const ProjectSchema = z.object({
  id: z.number(),
  name: z.string(),
  start_date: z.string(),
  target_date: z.string(),
  schedule_status: z.string(),
  overall_progress: z.number(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const MilestoneNoteSchema = z.object({
  text: z.string(),
  author: z.string(),
  at: z.string(),
});
export type MilestoneNote = z.infer<typeof MilestoneNoteSchema>;

export const MilestoneSchema = z.object({
  id: z.string(),
  title: z.string(),
  domain: z.string(),
  week: z.number(),
  phase: z.string().nullable(),
  planned_start: z.string().nullable(),
  planned_end: z.string().nullable(),
  actual_start: z.string().nullable(),
  actual_end: z.string().nullable(),
  drift_days: z.number(),
  is_key_milestone: bool,
  key_milestone_label: z.string().nullable(),
  dependencies: jsonArray(z.string()),
  notes: jsonArray(MilestoneNoteSchema),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Milestone = z.infer<typeof MilestoneSchema>;

export const AcceptanceCriterionSchema = z.object({ text: z.string(), done: z.boolean() });
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  milestone_id: z.string(),
  label: z.string(),
  status: z.enum(TASK_STATUSES),
  done: bool,
  assignee: z.string().nullable(),
  blocked_by: z.string().nullable(),
  blocked_reason: z.string().nullable(),
  blocked_from: z.enum(TASK_STATUSES).nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  completed_by: z.string().nullable(),
  priority: z.enum(PRIORITIES),
  notes: z.string().nullable(),
  prompt: z.string().nullable(),
  context_files: jsonArray(z.string()),
  reference_docs: jsonArray(z.string()),
  acceptance_criteria: jsonArray(AcceptanceCriterionSchema),
  constraints: jsonArray(z.string()),
  agent_target: z.string().nullable(),
  execution_mode: z.string(),
  depends_on: jsonArray(z.string()),
  last_run_id: z.string().nullable(),
  builder_prompt: z.string().nullable(),
  due_date: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['orchestrator', 'sub-agent', 'human', 'external']),
  parent_id: z.string().nullable(),
  color: z.string(),
  status: z.string(),
  permissions: jsonArray(z.string()),
  last_action_at: z.string().nullable(),
  session_action_count: z.number(),
  source_model: z.string().nullable(),
  created_at: z.string(),
  /** Who does this agent's work (M13.1): a text runner, an outside tool, or the operator. */
  executor: z.enum(['agent', 'external', 'human']),
  tool: z.string().nullable(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentLogSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  description: z.string().nullable(),
  timestamp: z.string(),
  tags: jsonArray(z.string()),
});
export type AgentLogEntry = z.infer<typeof AgentLogSchema>;

export const PhaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  start_week: z.number(),
  end_week: z.number(),
  color: z.string(),
});
export type Phase = z.infer<typeof PhaseSchema>;

export const LessonSchema = z.object({
  id: z.number(),
  subtask_id: z.string(),
  rejection_reason: z.string(),
  fix_applied: z.string(),
  prevention: z.string(),
  created_at: z.string(),
});
export type Lesson = z.infer<typeof LessonSchema>;

export interface TrackerState {
  project: Project;
  milestones: Milestone[];
  subtasks: Task[];
  agents: Agent[];
  agent_log: AgentLogEntry[];
  phases: Phase[];
  lessons_learned: Lesson[];
}
