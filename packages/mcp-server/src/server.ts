import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '@command-center/core';
import pkg from '../package.json' with { type: 'json' };
import { createSession } from './session';
import { registerAgentTools } from './tools/agent';
import { registerMilestoneTools } from './tools/milestone';
import { registerReadTools } from './tools/read';
import type { Ctx } from './tools/shared';
import { registerTaskTools } from './tools/task';

export const TOOL_COUNT = 25;

const INSTRUCTIONS = `Command Center is the shared project board for the human operator and AI agents.

Typical loop:
1. get_project_status, then list_tasks (status="todo") to pick work.
2. get_task_context for the task (get_task_summary for a quick look; get_lessons_learned to avoid past mistakes).
3. start_task -> do the work -> log_action as you go -> complete_task with a summary. The task then waits in Review for a human; do not approve your own work.
4. If stuck, block_task with a reason. If rejected, read get_task_history, fix it, and complete_task again.

You are registered automatically as the calling agent. To act for a sub-agent, register_agent it first and pass its id as agent_id. Errors say which tool to call next.`;

export interface ServerOptions {
  db: Db;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Build the MCP server with all 25 tools. Transport-agnostic so tests can use an in-memory pair. */
export function createServer({
  db,
  env = process.env,
  now = () => new Date(),
}: ServerOptions): McpServer {
  const server = new McpServer(
    { name: 'command-center', version: pkg.version },
    { instructions: INSTRUCTIONS },
  );
  const session = createSession(db, () => server.server.getClientVersion()?.name, env);
  const ctx: Ctx = { db, session, now };
  registerReadTools(server, ctx);
  registerTaskTools(server, ctx);
  registerMilestoneTools(server, ctx);
  registerAgentTools(server, ctx);
  return server;
}
