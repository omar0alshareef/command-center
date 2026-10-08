import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  addMilestoneNote,
  createMilestone,
  createTask,
  setMilestoneDates,
  updateDrift,
  type NewTask,
} from '@command-center/core';
import { z } from 'zod';
import { guard, ok } from '../results';
import { WRITES, agentId, milestoneId, taskBrief, tool, type Ctx } from './shared';

// .describe() must come last: on the inner string it is lost once the schema is wrapped in nullable/optional.
const date = (what: string) =>
  z.string().nullable().optional().describe(`${what} as YYYY-MM-DD, or null to clear.`);
const milestoneBrief = (m: {
  id: string;
  title: string;
  domain: string;
  week: number;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  drift_days: number;
}) => ({
  id: m.id,
  title: m.title,
  domain: m.domain,
  week: m.week,
  planned_start: m.planned_start,
  planned_end: m.planned_end,
  actual_start: m.actual_start,
  actual_end: m.actual_end,
  drift_days: m.drift_days,
});

export function registerMilestoneTools(server: McpServer, { db, session }: Ctx): void {
  tool(
    server,
    'add_milestone_note',
    {
      title: 'Add milestone note',
      description:
        'Append a dated note to a milestone (decisions, risks, status). Notes are visible in the milestone panel.',
      inputSchema: {
        milestone_id: milestoneId,
        text: z.string().min(1).max(2000).describe('The note.'),
        agent_id: agentId,
      },
      annotations: WRITES,
    },
    ({ milestone_id, text, agent_id }) =>
      guard(() => {
        const m = addMilestoneNote(db, milestone_id, text, session.resolveActor(agent_id));
        return ok({ ...milestoneBrief(m), notes: m.notes.length });
      }),
  );

  tool(
    server,
    'set_milestone_dates',
    {
      title: 'Set milestone dates',
      description:
        'Set planned and/or actual dates of a milestone (YYYY-MM-DD, or null to clear). Only the dates you pass change; end must not be before start.',
      inputSchema: {
        milestone_id: milestoneId,
        planned_start: date('Planned start'),
        planned_end: date('Planned end'),
        actual_start: date('Actual start'),
        actual_end: date('Actual end'),
        agent_id: agentId,
      },
      annotations: WRITES,
    },
    ({ milestone_id, agent_id, ...dates }) =>
      guard(() => {
        const set = Object.fromEntries(Object.entries(dates).filter(([, v]) => v !== undefined));
        return ok(
          milestoneBrief(setMilestoneDates(db, milestone_id, set, session.resolveActor(agent_id))),
        );
      }),
  );

  tool(
    server,
    'update_drift',
    {
      title: 'Update milestone drift',
      description:
        'Record how many days a milestone is ahead (negative) or behind (positive) its plan. Also refreshes the project schedule status (>= 7 days behind = behind, >= 1 = at risk). Give a reason; it is saved as a milestone note.',
      inputSchema: {
        milestone_id: milestoneId,
        drift_days: z
          .number()
          .int()
          .min(-365)
          .max(365)
          .describe('Days late (positive) or early (negative).'),
        reason: z.string().optional().describe('Why. Saved as a milestone note.'),
        agent_id: agentId,
      },
      annotations: WRITES,
    },
    ({ milestone_id, drift_days, reason, agent_id }) =>
      guard(() =>
        ok(
          milestoneBrief(
            updateDrift(db, milestone_id, drift_days, session.resolveActor(agent_id), reason),
          ),
        ),
      ),
  );

  tool(
    server,
    'create_milestone',
    {
      title: 'Create milestone',
      description:
        'Create a milestone. id defaults to the next M<n>; planned dates default from the project start and week. Dependencies must be existing milestone ids.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Milestone title.'),
        id: z
          .string()
          .optional()
          .describe('Optional explicit id (letters, digits, - _). Defaults to M<next number>.'),
        domain: z
          .string()
          .optional()
          .describe('Swim lane / domain name, e.g. "Backend". Default "general".'),
        week: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Project week it starts in (1-based). Default 1.'),
        phase: z.string().nullable().optional().describe('Existing phase id.'),
        planned_start: date('Planned start (default: derived from the project start and week)'),
        planned_end: date('Planned end (default: start + 6 days)'),
        is_key_milestone: z.boolean().optional().describe('Show as a key milestone diamond.'),
        key_milestone_label: z
          .string()
          .nullable()
          .optional()
          .describe('Label for the key milestone (defaults to the title).'),
        dependencies: z.array(z.string()).optional().describe('Milestone ids this one depends on.'),
        agent_id: agentId,
      },
      annotations: WRITES,
    },
    ({ agent_id, ...input }) =>
      guard(() => {
        const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
        return ok(
          milestoneBrief(createMilestone(db, fields as never, session.resolveActor(agent_id))),
        );
      }),
  );

  tool(
    server,
    'add_milestone_task',
    {
      title: 'Add task to milestone',
      description:
        'Create a new todo task in a milestone. Returns its id (TASK-###). Optional fields are applied in the same step.',
      inputSchema: {
        milestone_id: milestoneId,
        label: z.string().min(1).describe('Task title.'),
        priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Default P2.'),
        assignee: z
          .string()
          .nullable()
          .optional()
          .describe('Registered agent id (see list_agents).'),
        notes: z.string().nullable().optional().describe('Description / notes for the task.'),
        prompt: z
          .string()
          .nullable()
          .optional()
          .describe('The prompt an agent should run for this task.'),
        acceptance_criteria: z
          .array(z.object({ text: z.string(), done: z.boolean() }))
          .optional()
          .describe('Acceptance criteria as {text, done}.'),
        context_files: z.array(z.string()).optional().describe('Files relevant to the task.'),
        reference_docs: z.array(z.string()).optional().describe('Docs to read before starting.'),
        constraints: z
          .array(z.string())
          .optional()
          .describe('Hard constraints the work must respect.'),
        depends_on: z.array(z.string()).optional().describe('Task ids that must be done first.'),
        agent_id: agentId,
      },
      annotations: WRITES,
    },
    ({ milestone_id, label, priority, assignee, agent_id, ...fields }) =>
      guard(() => {
        const extra = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        const input: NewTask = {
          milestoneId: milestone_id,
          label,
          ...(priority ? { priority } : {}),
          ...(assignee !== undefined ? { assignee } : {}),
          fields: extra as NewTask['fields'],
        };
        return ok(taskBrief(createTask(db, input, session.resolveActor(agent_id))));
      }),
  );
}
