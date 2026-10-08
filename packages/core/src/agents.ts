import { z } from 'zod';
import { nowIso, write, type Db } from './db';
import { AgentNotFoundError, CoreError, ReservedAgentError } from './errors';
import { getAgent, logAction } from './queries';
import { toJson, type Agent } from './types';

/** The human operator and the system actor. Tool calls can never act as these. */
export const RESERVED_AGENT_IDS: readonly string[] = ['operator', 'system'];

/** UI/UX §6.3: ACTIVE = acted within the last 5 minutes, or explicitly marked active. */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
export function isAgentActive(
  agent: Pick<Agent, 'status' | 'last_action_at'>,
  now = Date.now(),
): boolean {
  if (agent.status === 'active') return true;
  return (
    agent.last_action_at !== null && now - Date.parse(agent.last_action_at) <= ACTIVE_WINDOW_MS
  );
}

const PALETTE = [
  '#8286FF',
  '#14B8A6',
  '#EC4899',
  '#F97316',
  '#06B6D4',
  '#22C55E',
  '#F59E0B',
  '#6366F1',
];
function defaultColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? '#9B9BAA';
}

export const AgentInputSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,47}$/, 'use lowercase letters, digits, . _ - (max 48 chars)'),
    name: z.string().trim().min(1).max(80),
    type: z.enum(['orchestrator', 'sub-agent', 'human', 'external']),
    parent_id: z.string().nullable(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'use a #RRGGBB hex color'),
    permissions: z.array(z.string().max(40)).max(20),
    source_model: z.string().max(80).nullable(),
  })
  .partial({ parent_id: true, color: true, permissions: true, source_model: true });
export type AgentInput = z.input<typeof AgentInputSchema>;

/**
 * Add or update an agent (upsert by id). Only provided optional fields change on update. Refuses
 * reserved ids, unknown parents and parent cycles. Logs `agent_registered` / `agent_updated`.
 */
export function registerAgent(db: Db, raw: AgentInput): Agent {
  const input = AgentInputSchema.parse(raw);
  if (RESERVED_AGENT_IDS.includes(input.id)) throw new ReservedAgentError(input.id);

  return write(db, () => {
    if (input.parent_id) {
      if (!getAgent(db, input.parent_id)) throw new AgentNotFoundError(input.parent_id);
      for (
        let cur: string | null = input.parent_id;
        cur;
        cur = getAgent(db, cur)?.parent_id ?? null
      ) {
        if (cur === input.id)
          throw new CoreError('AGENT_CYCLE', `Agent '${input.id}' cannot be its own ancestor.`);
      }
    }
    const existing = getAgent(db, input.id);
    if (!existing) {
      db.prepare(
        `INSERT INTO agents (id, name, type, parent_id, color, status, permissions, source_model, created_at)
         VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?)`,
      ).run(
        input.id,
        input.name,
        input.type,
        input.parent_id ?? null,
        input.color ?? defaultColor(input.id),
        toJson(input.permissions ?? []),
        input.source_model ?? null,
        nowIso(),
      );
    } else {
      const sets: string[] = ['name = @name', 'type = @type'];
      const params: Record<string, unknown> = { id: input.id, name: input.name, type: input.type };
      const optional: Record<string, unknown> = {
        parent_id: input.parent_id,
        color: input.color,
        permissions: input.permissions === undefined ? undefined : toJson(input.permissions),
        source_model: input.source_model,
      };
      for (const [column, value] of Object.entries(optional)) {
        if (value === undefined) continue;
        sets.push(`${column} = @${column}`);
        params[column] = value;
      }
      db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = @id`).run(params);
    }
    logAction(db, {
      agentId: input.id,
      action: existing ? 'agent_updated' : 'agent_registered',
      targetType: 'agent',
      targetId: input.id,
      description: `${input.name} (${input.type}) ${existing ? 'updated' : 'registered'}`,
      tags: ['agent'],
    });
    const agent = getAgent(db, input.id);
    if (!agent) throw new AgentNotFoundError(input.id);
    return agent;
  });
}
