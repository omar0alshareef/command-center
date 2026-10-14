import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  TaskNotFoundError,
  capTokens,
  formatLessonsBlock,
  getAssignment,
  getRequiredLessons,
  getTask,
  listLibraryAgents,
  parseSpecRules,
  projectDispatchBlock,
  proposeLesson,
  readProjectFile,
  readSpec,
} from '@command-center/core';
import { z } from 'zod';
import { fail, guard, ok } from '../results';
import { READ_ONLY, WRITES, agentId, taskId, tool, type Ctx } from './shared';

// M15 tools. All read the library or the project's spec; the only write is `propose_lesson`, and it can only make a DRAFT.
// There is deliberately no tool that creates or deletes library agents, promotes or retires a lesson, or changes a scope:
// an agent must not be able to widen its own permissions or remove a lesson that constrains it.

const SPEC_MAX_TOKENS = 6000;

export function registerLibraryTools(
  server: McpServer,
  { db, lib, projectRoot, session }: Ctx,
): void {
  tool(
    server,
    'list_library_agents',
    {
      title: 'List library agents',
      description:
        'The app-wide agent library (read-only): every active agent with its role, type, provider and model, and whether this project has it assigned and enabled. Creating, editing and assigning agents is done by the operator in the app.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      guard(() => {
        if (!lib)
          return fail(
            'The agent library is not available to this server (COMMAND_CENTER_LIBRARY is not set).',
          );
        return ok(
          listLibraryAgents(lib).map((a) => {
            const link = getAssignment(db, a.id);
            return {
              id: a.id,
              name: a.name,
              role: a.role,
              type: a.type,
              executor: a.executor,
              provider: a.provider ?? 'claude-code',
              model: a.model,
              in_this_project: !!link && !link.removed_at,
              enabled_here: !!link && !link.removed_at && link.enabled,
            };
          }),
        );
      }),
  );

  tool(
    server,
    'get_project_spec',
    {
      title: 'Get project spec',
      description:
        'The project’s own rules (AGENTS.md) that add to your general profile and win where they conflict, plus the tools it forbids. Status is "missing" when the project has no spec (then only your profile and lessons apply). Read this before starting work in a project you have not seen.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      guard(() => {
        if (!projectRoot) return fail('The project folder is unknown to this server.');
        const file = readProjectFile(projectRoot);
        const spec = readSpec(projectRoot, file.ok ? file.project : null);
        return ok({
          project: file.ok ? file.project.name : null,
          project_file_problems: file.ok ? [] : file.issues,
          dispatch_blocked: projectDispatchBlock(projectRoot),
          spec_status: spec.status,
          spec_hash: spec.hash,
          forbidden_tools: spec.text ? parseSpecRules(spec.text).forbiddenTools : [],
          spec: spec.text
            ? capTokens(
                spec.text,
                SPEC_MAX_TOKENS,
                'The spec file is longer; open it for the rest.',
              ).text
            : null,
        });
      }),
  );

  tool(
    server,
    'get_lessons_for_task',
    {
      title: 'Get required lessons for a task',
      description:
        'The lessons you must read before starting this task: ones for you specifically, for this project, and for every agent, matched to the task’s words, newest first (max 10). The same block is put at the top of a run’s prompt by the orchestrator.',
      inputSchema: { task_id: taskId, agent_id: agentId },
      annotations: READ_ONLY,
    },
    ({ task_id, agent_id }) =>
      guard(() => {
        const t = getTask(db, task_id);
        if (!t) throw new TaskNotFoundError(task_id);
        const actor = session.resolveActor(agent_id);
        const lessons = getRequiredLessons(db, lib, {
          agentId: actor,
          taskId: t.id,
          label: t.label,
          keywords: t.acceptance_criteria.map((c) => c.text),
        });
        return ok({
          count: lessons.length,
          lessons: lessons.map((l) => ({
            id: `${l.source === 'library' ? 'library' : 'project'}:${l.id}`,
            scope: l.scope,
            status: l.status,
            reason: l.reason,
            fix: l.fix,
            prevention: l.prevention,
            check: l.check_text,
            check_type: l.check_type,
          })),
          block: formatLessonsBlock(lessons),
        });
      }),
  );

  tool(
    server,
    'propose_lesson',
    {
      title: 'Propose a lesson',
      description:
        'After your own mistake on a task was pointed out, propose a lesson so it is not repeated. It is saved as a DRAFT that applies only to this project and only after a human reviews it; a human adds the real prevention check and decides whether it is promoted. You cannot activate, promote or retire lessons. Put a check you would suggest in "check".',
      inputSchema: {
        task_id: taskId,
        reason: z.string().min(1).max(2000).describe('What went wrong, in one or two sentences.'),
        fix: z.string().max(2000).optional().describe('How it was fixed.'),
        check: z
          .string()
          .max(500)
          .optional()
          .describe(
            'A suggested prevention check: a short, verifiable statement. Kept as text only.',
          ),
        agent_id: agentId,
      },
      annotations: WRITES,
    },
    ({ task_id, reason, fix, check, agent_id }) =>
      guard(() => {
        const actor = session.resolveActor(agent_id);
        const l = proposeLesson(db, task_id, {
          reason,
          ...(fix ? { fix } : {}),
          ...(check ? { check } : {}),
          agentId: actor,
        });
        return ok({
          lesson_id: l.id,
          status: l.status,
          scope: l.scope,
          note: 'Saved as a draft for this project. A human reviews it before it applies elsewhere.',
        });
      }),
  );
}
