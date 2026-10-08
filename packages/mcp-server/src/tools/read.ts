import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  TASK_STATUSES,
  TaskNotFoundError,
  MilestoneNotFoundError,
  buildTaskContextMd,
  capTokens,
  estimateTokens,
  getActivityFeed,
  getLessonsForTask,
  getMilestoneOverview,
  getProjectStatus,
  getRelevantLessons,
  getTask,
  getTaskHistory,
  getTaskSummary,
  isAgentActive,
  listAgents,
  listLessons,
  listTasks,
  type TaskSummary,
} from '@command-center/core';
import { z } from 'zod';
import { guard, ok } from '../results';
import { READ_ONLY, clampLimit, milestoneId, taskId, tool, type Ctx } from './shared';

/** Hard budgets from the roadmap: full context ~8K tokens, summary ~500. */
export const CONTEXT_MAX_TOKENS = 8000;
export const SUMMARY_MAX_TOKENS = 500;

/** Shrink a summary until it fits its budget, dropping the least important parts first. */
function fitSummary(s: TaskSummary): TaskSummary {
  const steps: ((x: TaskSummary) => TaskSummary)[] = [
    (x) => ({ ...x, criteria: { ...x.criteria, open: x.criteria.open.slice(0, 2) } }),
    (x) => ({ ...x, depends_on: x.depends_on.slice(0, 5), criteria: { ...x.criteria, open: [] } }),
    (x) => ({ ...x, last_event: null, depends_on: x.depends_on.slice(0, 3) }),
  ];
  let out = s;
  for (const step of steps) {
    if (estimateTokens(JSON.stringify(out)) <= SUMMARY_MAX_TOKENS) break;
    out = step(out);
  }
  return out;
}

export function registerReadTools(server: McpServer, { db, now }: Ctx): void {
  tool(
    server,
    'get_task_context',
    {
      title: 'Get task context',
      description:
        'Full working context for ONE task as markdown (description, acceptance criteria, context files, reference docs, constraints, relevant lessons from past rejections). Capped at ~8,000 tokens with a truncation notice. Read this before starting a task. For a quick look use get_task_summary.',
      inputSchema: { task_id: taskId },
      annotations: READ_ONLY,
    },
    ({ task_id }) =>
      guard(() => {
        const md = buildTaskContextMd(db, task_id, now());
        if (md === null) throw new TaskNotFoundError(task_id);
        return ok(
          capTokens(
            md,
            CONTEXT_MAX_TOKENS,
            'Call get_task_summary for a short version or get_task_history for the log.',
          ).text,
        );
      }),
  );

  tool(
    server,
    'get_task_summary',
    {
      title: 'Get task summary',
      description:
        'Slim snapshot of ONE task (~500 tokens max): status, priority, assignee, milestone, open acceptance criteria, blockers, dependency statuses, last event. Use it to decide what to do next without loading the full context.',
      inputSchema: { task_id: taskId },
      annotations: READ_ONLY,
    },
    ({ task_id }) =>
      guard(() => {
        const s = getTaskSummary(db, task_id);
        if (!s) throw new TaskNotFoundError(task_id);
        return ok(fitSummary(s));
      }),
  );

  tool(
    server,
    'get_project_status',
    {
      title: 'Get project status',
      description:
        'Project overview: current week and phase, overall progress %, schedule status and max drift, task counts per status, blocked tasks with reasons, tasks awaiting review, agent counts, and the one-line context string. Start here when you do not know what to work on.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => guard(() => ok(getProjectStatus(db, now()))),
  );

  tool(
    server,
    'get_milestone_overview',
    {
      title: 'Get milestone overview',
      description:
        'Milestones with dates, drift, dependencies and task progress per status. Pass milestone_id for one, or omit it for all milestones.',
      inputSchema: { milestone_id: milestoneId.optional() },
      annotations: READ_ONLY,
    },
    ({ milestone_id }) =>
      guard(() => {
        const out = getMilestoneOverview(db, milestone_id);
        if (milestone_id && out.length === 0) throw new MilestoneNotFoundError(milestone_id);
        return ok(out);
      }),
  );

  tool(
    server,
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List tasks, optionally filtered. Returns compact rows (id, label, status, priority, assignee, milestone) plus the total match count. Default limit 50, max 200; narrow with filters if truncated.',
      inputSchema: {
        milestone_id: milestoneId.optional(),
        status: z.enum(TASK_STATUSES).optional().describe('Only tasks in this status.'),
        assignee: z
          .string()
          .optional()
          .describe('Only tasks assigned to this agent id (see list_agents).'),
        priority: z
          .enum(['P0', 'P1', 'P2', 'P3'])
          .optional()
          .describe('Only this priority (P0 is most urgent).'),
        search: z
          .string()
          .optional()
          .describe('Case-insensitive text matched against task id and label.'),
        limit: z.number().int().optional().describe('Max rows to return (default 50, max 200).'),
      },
      annotations: READ_ONLY,
    },
    ({ milestone_id, status, assignee, priority, search, limit }) =>
      guard(() => {
        const all = listTasks(db, {
          ...(milestone_id ? { milestoneId: milestone_id } : {}),
          ...(status ? { status } : {}),
          ...(assignee ? { assignee } : {}),
          ...(priority ? { priority } : {}),
          ...(search ? { search } : {}),
        });
        const max = clampLimit(limit, 50, 200);
        return ok({
          total: all.length,
          returned: Math.min(all.length, max),
          tasks: all.slice(0, max).map((t) => ({
            id: t.id,
            label: t.label,
            status: t.status,
            priority: t.priority,
            assignee: t.assignee,
            milestone_id: t.milestone_id,
            ...(t.depends_on.length ? { depends_on: t.depends_on } : {}),
            ...(t.status === 'blocked' ? { blocked_reason: t.blocked_reason } : {}),
          })),
        });
      }),
  );

  tool(
    server,
    'get_task_history',
    {
      title: 'Get task history',
      description:
        'Everything that happened to one task, newest first: log entries (who did what, when) and any rejection lessons with the reason. Use it to see why a task was rejected before redoing it.',
      inputSchema: {
        task_id: taskId,
        limit: z.number().int().optional().describe('Max log entries (default 30, max 200).'),
      },
      annotations: READ_ONLY,
    },
    ({ task_id, limit }) =>
      guard(() => {
        if (!getTask(db, task_id)) throw new TaskNotFoundError(task_id);
        const h = getTaskHistory(db, task_id, clampLimit(limit, 30, 200));
        return ok({
          log: h.log.map((e) => ({
            at: e.timestamp,
            agent: e.agent_id,
            action: e.action,
            description: e.description,
          })),
          lessons: h.lessons.map((l) => ({
            at: l.created_at,
            rejection_reason: l.rejection_reason,
            fix_applied: l.fix_applied,
          })),
        });
      }),
  );

  tool(
    server,
    'list_agents',
    {
      title: 'List agents',
      description:
        'All registered agents with hierarchy, type, status (active = acted in the last 5 minutes), action count and source model. Use ids from here for assignee and agent_id.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      guard(() =>
        ok(
          listAgents(db).map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            parent_id: a.parent_id,
            status: isAgentActive(a, now().getTime()) ? 'active' : 'idle',
            actions: a.session_action_count,
            last_action_at: a.last_action_at,
            source_model: a.source_model,
          })),
        ),
      ),
  );

  tool(
    server,
    'get_activity_feed',
    {
      title: 'Get activity feed',
      description:
        'Recent activity, newest first, paginated. To get the next page pass the returned next_cursor as before_timestamp and before_id. Filter by agent_id or target_id (e.g. a task id).',
      inputSchema: {
        limit: z.number().int().optional().describe('Entries per page (default 30, max 200).'),
        before_timestamp: z
          .string()
          .optional()
          .describe('Cursor: timestamp of the last entry of the previous page.'),
        before_id: z
          .string()
          .optional()
          .describe(
            'Cursor: id of the last entry of the previous page. Required with before_timestamp.',
          ),
        agent_id: z.string().optional().describe('Only entries by this agent.'),
        target_id: z.string().optional().describe('Only entries about this task or milestone id.'),
      },
      annotations: READ_ONLY,
    },
    ({ limit, before_timestamp, before_id, agent_id, target_id }) =>
      guard(() => {
        const max = clampLimit(limit, 30, 200);
        const entries = getActivityFeed(db, {
          limit: max + 1,
          ...(before_timestamp && before_id
            ? { before: { timestamp: before_timestamp, id: before_id } }
            : {}),
          ...(agent_id ? { agentId: agent_id } : {}),
          ...(target_id ? { targetId: target_id } : {}),
        });
        const page = entries.slice(0, max);
        const last = page[page.length - 1];
        return ok({
          entries: page.map((e) => ({
            id: e.id,
            at: e.timestamp,
            agent: e.agent_id,
            action: e.action,
            target: e.target_id,
            description: e.description,
            tags: e.tags,
          })),
          next_cursor:
            entries.length > max && last
              ? { before_timestamp: last.timestamp, before_id: last.id }
              : null,
        });
      }),
  );

  tool(
    server,
    'get_lessons_learned',
    {
      title: 'Get lessons learned',
      description:
        'Past rejections and the fixes that resolved them. With task_id: that task’s own rejections plus lessons relevant to its topic. With query: lessons matching the text. With neither: the 20 most recent. Read these before starting similar work to avoid repeating mistakes.',
      inputSchema: {
        task_id: taskId.optional(),
        query: z
          .string()
          .optional()
          .describe('Free text to match against past rejection reasons and fixes.'),
        limit: z
          .number()
          .int()
          .optional()
          .describe('Max lessons (default 5 for task/query, 20 otherwise; max 50).'),
      },
      annotations: READ_ONLY,
    },
    ({ task_id, query, limit }) =>
      guard(() => {
        let lessons;
        if (task_id) {
          const t = getTask(db, task_id);
          if (!t) throw new TaskNotFoundError(task_id);
          lessons = getLessonsForTask(db, t.id, t.label, clampLimit(limit, 5, 50));
        } else if (query) {
          lessons = getRelevantLessons(db, query, [], clampLimit(limit, 5, 50));
        } else {
          lessons = listLessons(db).slice(0, clampLimit(limit, 20, 50));
        }
        return ok(
          lessons.map((l) => ({
            task_id: l.subtask_id,
            at: l.created_at,
            rejection_reason: l.rejection_reason,
            fix_applied: l.fix_applied,
          })),
        );
      }),
  );
}
