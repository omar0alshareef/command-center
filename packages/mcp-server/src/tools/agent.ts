import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAgent } from '@command-center/core';
import { z } from 'zod';
import { guard, ok } from '../results';
import { WRITES, tool, type Ctx } from './shared';

export function registerAgentTools(server: McpServer, { db, session }: Ctx): void {
  tool(
    server,
    'register_agent',
    {
      title: 'Register agent',
      description:
        'Add or update an agent in the roster (upsert by id). You are registered automatically on your first call, so use this to register sub-agents (then pass their id as agent_id on later calls), set your source model, or fix your name/color. A sub-agent with no parent_id becomes your child. Human, operator and system agents cannot be registered here.',
      inputSchema: {
        id: z
          .string()
          .describe('Lowercase id: letters, digits, . _ - (max 48), e.g. "research-explorer".'),
        name: z.string().min(1).describe('Display name.'),
        type: z
          .enum(['orchestrator', 'sub-agent', 'external'])
          .describe(
            'orchestrator = top-level agent, sub-agent = child of another agent, external = another tool or model.',
          ),
        parent_id: z
          .string()
          .nullable()
          .optional()
          .describe('Parent agent id (defaults to you for sub-agents).'),
        color: z.string().optional().describe('#RRGGBB. Defaults to a color derived from the id.'),
        permissions: z
          .array(z.string())
          .optional()
          .describe('Free-form permission labels shown in the roster, e.g. ["read","write"].'),
        source_model: z
          .string()
          .optional()
          .describe('Model behind the agent, e.g. "claude-sonnet-5-5".'),
      },
      annotations: { ...WRITES, idempotentHint: true },
    },
    (input) =>
      guard(() => {
        const self = session.self();
        const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
        const withParent =
          input.type === 'sub-agent' && input.parent_id === undefined && input.id !== self
            ? { ...fields, parent_id: self }
            : fields;
        const a = registerAgent(db, withParent as never);
        return ok({
          id: a.id,
          name: a.name,
          type: a.type,
          parent_id: a.parent_id,
          color: a.color,
          source_model: a.source_model,
          permissions: a.permissions,
        });
      }),
  );
}
