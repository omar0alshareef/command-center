import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AgentNotFoundError,
  CoreError,
  DependenciesIncompleteError,
  ForeignAgentError,
  IllegalTransitionError,
  MilestoneNotFoundError,
  ReasonRequiredError,
  ReservedAgentError,
  SelfApprovalError,
  TaskNotFoundError,
  type TaskStatus,
} from '@command-center/core';
import { ZodError } from 'zod';

// stdout belongs to the MCP protocol. Never console.log in this package; use `log` (stderr).
export const log = (...parts: unknown[]): void => {
  console.error('[command-center-mcp]', ...parts);
};

/** Compact JSON keeps token cost down; strings (markdown) pass through as-is. */
export const ok = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
});

export const fail = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

const NEXT_STEP: Record<TaskStatus, string> = {
  todo: 'It has not started: call start_task (or block_task if it cannot start).',
  in_progress:
    'It is being worked on: call complete_task when finished, or block_task if you are stuck.',
  review: 'It is waiting for review: call approve_task, or reject_task with a reason.',
  blocked: 'It is blocked: call unblock_task first.',
  done: 'It is already done. Call reset_task only if it must be redone.',
};

/**
 * Turn any thrown value into a message an agent can act on. Names the tool to call next; never
 * includes stack traces or internals.
 */
export function describeError(e: unknown): string {
  if (e instanceof IllegalTransitionError) return `${e.message} ${NEXT_STEP[e.from]}`;
  if (e instanceof ReasonRequiredError) return `${e.message} Pass a non-empty "reason" saying why.`;
  if (e instanceof DependenciesIncompleteError) {
    return `${e.message} Inspect them with get_task_summary, or retry start_task with force=true if you must start anyway.`;
  }
  if (e instanceof TaskNotFoundError) return `${e.message} Call list_tasks to find valid task ids.`;
  if (e instanceof MilestoneNotFoundError)
    return `${e.message} Call get_milestone_overview to list milestone ids.`;
  if (e instanceof AgentNotFoundError) {
    return `${e.message} Call register_agent to register it first, or list_agents to see registered agents.`;
  }
  if (e instanceof ReservedAgentError)
    return `${e.message} Omit agent_id to act as yourself (the session agent).`;
  if (e instanceof ForeignAgentError) {
    return `${e.message} To use a sub-agent, call register_agent with type "sub-agent" (it becomes your child), then pass its id as agent_id.`;
  }
  if (e instanceof SelfApprovalError) return e.message;
  if (e instanceof ZodError) {
    return `Invalid input: ${e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}.`;
  }
  if (e instanceof CoreError) return e.message;
  log('unexpected error:', e);
  return `Unexpected error: ${e instanceof Error ? e.message : String(e)}. The server is still running; check your input and retry.`;
}

/** Run a tool body; any throw becomes an isError result instead of crashing the server. */
export async function guard(
  fn: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(describeError(e));
  }
}
