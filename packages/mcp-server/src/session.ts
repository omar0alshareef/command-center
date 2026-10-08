import {
  AgentNotFoundError,
  ForeignAgentError,
  RESERVED_AGENT_IDS,
  ReservedAgentError,
  getAgent,
  isSelfOrDescendant,
  registerAgent,
  type Db,
} from '@command-center/core';

/**
 * Who is calling. A stdio MCP connection is one agent session: its identity comes from the
 * client's `initialize` info (or COMMAND_CENTER_AGENT_* env), never from a tool argument. Tools may
 * name a *registered sub-agent* via `agent_id`, but never `operator`, `system` or a human agent.
 */
export interface Session {
  /** The session's own agent id, registering it on first use. */
  self(): string;
  /** Actor for a tool call: the session agent, or a validated registered sub-agent. */
  resolveActor(agentId?: string): string;
}

const SESSION_TYPES = ['orchestrator', 'sub-agent', 'external'] as const;
type SessionType = (typeof SESSION_TYPES)[number];

/** Lowercase slug that satisfies the agent id pattern; reserved ids get a suffix. */
export function slugAgentId(raw: string | undefined): string {
  const slug = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 48);
  const id = slug || 'mcp-agent';
  return RESERVED_AGENT_IDS.includes(id) ? `${id}-agent` : id;
}

export function createSession(
  db: Db,
  clientName: () => string | undefined,
  env: NodeJS.ProcessEnv,
): Session {
  const self = (): string => {
    const name = env['COMMAND_CENTER_AGENT_NAME']?.trim() || clientName() || 'MCP agent';
    let id = slugAgentId(env['COMMAND_CENTER_AGENT_ID']?.trim() || clientName());
    const existing = getAgent(db, id);
    // A human agent with this id is not us; do not take over their identity.
    if (existing?.type === 'human') id = `${id}-agent`;
    if (!getAgent(db, id)) {
      const wanted = env['COMMAND_CENTER_AGENT_TYPE'] as SessionType | undefined;
      registerAgent(db, {
        id,
        name,
        type: wanted && SESSION_TYPES.includes(wanted) ? wanted : 'orchestrator',
        ...(env['COMMAND_CENTER_AGENT_MODEL']
          ? { source_model: env['COMMAND_CENTER_AGENT_MODEL'] }
          : {}),
      });
    }
    return id;
  };

  return {
    self,
    resolveActor(agentId) {
      if (agentId === undefined) return self();
      if (RESERVED_AGENT_IDS.includes(agentId)) throw new ReservedAgentError(agentId);
      const agent = getAgent(db, agentId);
      if (!agent) throw new AgentNotFoundError(agentId);
      if (agent.type === 'human') throw new ReservedAgentError(agentId);
      // Acting as an unrelated agent would let a session impersonate a reviewer (or register a puppet to approve its own work).
      const me = self();
      if (!isSelfOrDescendant(db, agentId, me)) throw new ForeignAgentError(agentId, me);
      return agentId;
    },
  };
}
