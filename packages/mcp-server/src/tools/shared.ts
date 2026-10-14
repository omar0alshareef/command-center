import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Db, LibraryDb, Task } from '@command-center/core';
import { z } from 'zod';
import type { Session } from '../session';

export interface Ctx {
  db: Db;
  /** The app-wide agent library (read-only), when the app told this server where it is. */
  lib: LibraryDb | null;
  /** The project folder (where the spec lives), or null when it cannot be told. */
  projectRoot: string | null;
  session: Session;
  now: () => Date;
}

export const taskId = z
  .string()
  .min(1)
  .describe('Task id such as TASK-014. Call list_tasks to find ids.');
export const milestoneId = z
  .string()
  .min(1)
  .describe('Milestone id such as M3. Call get_milestone_overview to list ids.');

export const agentId = z
  .string()
  .optional()
  .describe(
    'Optional. Set ONLY when acting on behalf of another registered sub-agent (see list_agents). Omit to act as yourself. Cannot be "operator", "system" or a human agent.',
  );

export const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const WRITES = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** What a write tool returns about a task: enough to confirm the change, cheap in tokens. */
export function taskBrief(t: Task) {
  return {
    id: t.id,
    label: t.label,
    status: t.status,
    priority: t.priority,
    assignee: t.assignee,
    milestone_id: t.milestone_id,
    ...(t.status === 'blocked'
      ? { blocked_reason: t.blocked_reason, blocked_by: t.blocked_by }
      : {}),
    updated_at: t.updated_at,
  };
}

export const clampLimit = (n: number | undefined, fallback: number, max: number): number =>
  Math.min(max, Math.max(1, Math.floor(n ?? fallback)));

/**
 * Register a tool with a STRICT input schema. The SDK's default object schema silently drops
 * unknown keys, so `update_task({status: "done"})` would "succeed" without doing anything and the
 * agent would believe it worked. Strict makes that an explicit error naming the unknown key.
 */
export function tool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: S; annotations: ToolAnnotations },
  cb: (args: z.output<z.ZodObject<S>>) => CallToolResult | Promise<CallToolResult>,
): void {
  server.registerTool(
    name,
    { ...config, inputSchema: z.strictObject(config.inputSchema) },
    (args: unknown) => cb(args as z.output<z.ZodObject<S>>),
  );
}
