import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  TaskNotFoundError,
  enrichTask,
  getTask,
  logAction,
  transition,
  updateTask,
  type TaskPatch,
} from '@command-center/core';
import { z } from 'zod';
import { guard, ok } from '../results';
import { WRITES, agentId, taskBrief, taskId, tool, type Ctx } from './shared';

const priority = z.enum(['P0', 'P1', 'P2', 'P3']).describe('P0 is most urgent, P3 least.');
const stringList = (what: string) => z.array(z.string()).describe(what);
const criteria = z
  .array(z.union([z.string(), z.object({ text: z.string(), done: z.boolean() })]))
  .describe('Acceptance criteria: plain strings, or {text, done} objects.');

export function registerTaskTools(server: McpServer, { db, session }: Ctx): void {
  const run = (
    name: string,
    title: string,
    description: string,
    extra: z.ZodRawShape,
    body: (a: Record<string, unknown>, actor: string) => ReturnType<typeof transition>,
    annotations: Record<string, boolean> = WRITES,
  ) =>
    tool(
      server,
      name,
      {
        title,
        description,
        inputSchema: { task_id: taskId, ...extra, agent_id: agentId },
        annotations,
      },
      (args: Record<string, unknown>) =>
        guard(() =>
          ok(taskBrief(body(args, session.resolveActor(args['agent_id'] as string | undefined)))),
        ),
    );
  const tid = (a: Record<string, unknown>) => a['task_id'] as string;
  const str = (a: Record<string, unknown>, k: string) => a[k] as string | undefined;

  run(
    'start_task',
    'Start task',
    'Begin work on a task: todo -> in_progress. Fails if it is not todo, or if tasks it depends_on are not done (see get_task_summary); pass force=true only if you must start anyway. Read get_task_context first.',
    { force: z.boolean().optional().describe('Start even though dependencies are unfinished.') },
    (a, actor) => transition(db, tid(a), 'start', { actor, force: a['force'] === true }),
  );

  run(
    'complete_task',
    'Complete task',
    'Submit finished work for review: in_progress -> review. The task then waits for the human operator (or a reviewer) to approve or reject it. Only call it after build, typecheck and tests pass.',
    {
      summary: z
        .string()
        .optional()
        .describe('What you did and how you verified it. Shown in the activity log.'),
    },
    (a, actor) =>
      transition(db, tid(a), 'complete', {
        actor,
        ...(str(a, 'summary') ? { summary: str(a, 'summary') as string } : {}),
      }),
  );

  run(
    'approve_task',
    'Approve task',
    'Accept reviewed work: review -> done. This is a reviewer action; do not approve your own work unless you were asked to.',
    {},
    (a, actor) => transition(db, tid(a), 'approve', { actor }),
  );

  run(
    'reject_task',
    'Reject task',
    'Send reviewed work back: review -> in_progress. The reason is required and is saved as a lesson learned, so make it specific and reusable (what was wrong, what to check next time).',
    {
      reason: z
        .string()
        .min(1)
        .describe('What was wrong and what must change. Saved as a lesson learned.'),
    },
    (a, actor) => transition(db, tid(a), 'reject', { actor, reason: str(a, 'reason') as string }),
  );

  run(
    'reset_task',
    'Reset task',
    'DESTRUCTIVE: clear a task back to todo (status, completion, blockers and run state). Use only to redo a task from scratch.',
    {},
    (a, actor) => transition(db, tid(a), 'reset', { actor }),
    { ...WRITES, destructiveHint: true },
  );

  run(
    'block_task',
    'Block task',
    'Mark a todo / in_progress / review task as blocked. The reason is required. Remembers the previous status so unblock_task can restore it.',
    {
      reason: z.string().min(1).describe('What is blocking this task.'),
      blocked_by: z
        .string()
        .optional()
        .describe('Id of the blocking task, if any. Defaults to "manual".'),
    },
    (a, actor) =>
      transition(db, tid(a), 'block', {
        actor,
        reason: str(a, 'reason') as string,
        ...(str(a, 'blocked_by') ? { blockedBy: str(a, 'blocked_by') as string } : {}),
      }),
  );

  run(
    'unblock_task',
    'Unblock task',
    'Clear a block: blocked -> the status it had before (todo if unknown).',
    {},
    (a, actor) => transition(db, tid(a), 'unblock', { actor }),
  );

  tool(
    server,
    'update_task',
    {
      title: 'Update task fields',
      description:
        'Edit task fields (not status; use start_task, complete_task, etc. for that). Only the fields you pass change. Lists (context_files, constraints, ...) are REPLACED; to add without losing existing entries use enrich_task.',
      inputSchema: {
        task_id: taskId,
        label: z.string().optional().describe('New title.'),
        notes: z.string().nullable().optional().describe('Description / notes. null clears.'),
        priority: priority.optional(),
        assignee: z
          .string()
          .nullable()
          .optional()
          .describe('Registered agent id (see list_agents), or null to unassign.'),
        prompt: z
          .string()
          .nullable()
          .optional()
          .describe('The prompt an agent should run for this task.'),
        builder_prompt: z.string().nullable().optional().describe('Extended builder prompt.'),
        agent_target: z
          .string()
          .nullable()
          .optional()
          .describe('Agent intended to execute the task.'),
        execution_mode: z.string().optional().describe('"agent" or "human".'),
        context_files: stringList('Files relevant to the task (replaces the list).').optional(),
        reference_docs: stringList('Docs to read (replaces the list).').optional(),
        constraints: stringList('Hard constraints (replaces the list).').optional(),
        depends_on: stringList('Task ids that must be done first (replaces the list).').optional(),
        acceptance_criteria: z
          .array(z.object({ text: z.string(), done: z.boolean() }))
          .optional()
          .describe(
            'Acceptance criteria as {text, done} (replaces the list; use done=true to tick one).',
          ),
        agent_id: agentId,
      },
      annotations: WRITES,
    },
    ({ task_id, agent_id, ...patch }) =>
      guard(() => {
        const fields = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        ) as TaskPatch;
        return ok(taskBrief(updateTask(db, task_id, fields, session.resolveActor(agent_id))));
      }),
  );

  tool(
    server,
    'log_action',
    {
      title: 'Log action',
      description:
        'Append an entry to the activity feed (what you just did). Use a snake_case action such as exploration_complete, file_edited, tests_passed. Attach task_id so it appears in that task’s history.',
      inputSchema: {
        action: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/, 'use snake_case, e.g. exploration_complete')
          .describe('Short snake_case action name, e.g. exploration_complete.'),
        task_id: taskId.optional(),
        description: z
          .string()
          .max(1000)
          .optional()
          .describe('One or two sentences on what happened.'),
        tags: z
          .array(z.string().max(30))
          .max(10)
          .optional()
          .describe('Optional short tags, e.g. ["research"].'),
        agent_id: agentId,
      },
      annotations: WRITES,
    },
    ({ action, task_id, description, tags, agent_id }) =>
      guard(() => {
        const actor = session.resolveActor(agent_id);
        if (task_id && !getTask(db, task_id)) throw new TaskNotFoundError(task_id);
        const id = logAction(db, {
          agentId: actor,
          action,
          ...(task_id ? { targetType: 'subtask', targetId: task_id } : {}),
          ...(description ? { description } : {}),
          ...(tags ? { tags } : {}),
        });
        return ok({ logged: true, id, agent: actor });
      }),
  );

  tool(
    server,
    'enrich_task',
    {
      title: 'Enrich task',
      description:
        'ADD context to a task without overwriting it: lists (context_files, reference_docs, constraints, depends_on, acceptance_criteria) are merged and de-duplicated; prompt, builder_prompt and notes replace the old text when provided. Use during preparation.',
      inputSchema: {
        task_id: taskId,
        prompt: z
          .string()
          .nullable()
          .optional()
          .describe('Prompt for the executing agent (replaces).'),
        builder_prompt: z.string().nullable().optional().describe('Builder prompt (replaces).'),
        notes: z.string().nullable().optional().describe('Notes (replaces).'),
        acceptance_criteria: criteria.optional(),
        context_files: stringList('Files to add.').optional(),
        reference_docs: stringList('Docs to add.').optional(),
        constraints: stringList('Constraints to add.').optional(),
        depends_on: stringList('Task ids to add as dependencies.').optional(),
        agent_id: agentId,
      },
      annotations: WRITES,
    },
    ({ task_id, agent_id, ...input }) =>
      guard(() => {
        const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
        return ok(taskBrief(enrichTask(db, task_id, fields, session.resolveActor(agent_id))));
      }),
  );
}
