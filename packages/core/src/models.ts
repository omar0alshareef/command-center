import { z } from 'zod';
import { write, type Db } from './db';
import { AgentNotFoundError, CoreError, InvalidInputError } from './errors';
import { DEFAULT_PROVIDER, isProviderId, PROVIDER_IDS, type ProviderId } from './providers/types';
import { getAgent, logAction } from './queries';
import type { Agent } from './types';

// Which model an agent runs on, per provider (M14). Names are never hardcoded in code paths: each provider's list
// lives in the `settings` table as an editable JSON array, seeded with starter entries. Claude Code's list is the one
// shipped in Slice 1 (`claude.models`); the others use `models.<provider>`. Local models come from the server itself.

export const CLAUDE_MODELS_KEY = 'claude.models';

export const modelsKey = (provider: ProviderId): string =>
  provider === 'claude-code' ? CLAUDE_MODELS_KEY : `models.${provider}`;

export const ModelOptionSchema = z.strictObject({
  /** What the provider is called with: for `claude --model` an alias such as `sonnet`, for APIs a full model id. */
  id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._:\-[\]/]*$/,
      'use letters, digits and . _ : - / [ ] (no spaces)',
    ),
  label: z.string().trim().min(1).max(60),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

export const ModelListSchema = z
  .array(ModelOptionSchema)
  .max(30)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((m, i) => {
      if (seen.has(m.id))
        ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate id "${m.id}"` });
      seen.add(m.id);
    });
  });

/** Verified against `claude --help` and a live `claude -p --model <alias>` run on 2026-10-13 (claude 2.1.296). */
export const DEFAULT_CLAUDE_MODELS: readonly ModelOption[] = [
  { id: 'haiku', label: 'Haiku (fast)' },
  { id: 'sonnet', label: 'Sonnet (balanced)' },
  { id: 'opus', label: 'Opus (strongest)' },
];

/** Starter lists. API model ids change often: edit them in Settings → Providers. Local models are not listed (the server reports them). */
export const DEFAULT_MODELS: Record<ProviderId, readonly ModelOption[]> = {
  'claude-code': DEFAULT_CLAUDE_MODELS,
  'anthropic-api': [
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (fast)' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (balanced)' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5 (strongest)' },
  ],
  'openai-api': [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini (fast)' },
    { id: 'gpt-4o', label: 'GPT-4o' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (fast)' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  local: [],
};

function readSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

/** A provider's model list: the stored one when it is valid, else the starter entries. */
export function getModelList(db: Db, provider: ProviderId): ModelOption[] {
  const raw = readSetting(db, modelsKey(provider));
  if (raw !== null) {
    try {
      const parsed = ModelListSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through to the defaults */
    }
  }
  return DEFAULT_MODELS[provider].map((m) => ({ ...m }));
}

/** Replace a provider's model list. Validates the shape and rejects duplicate ids; an empty list is allowed ("default" only). */
export function setModelList(
  db: Db,
  provider: ProviderId,
  raw: unknown,
  actor = 'operator',
): ModelOption[] {
  const list = ModelListSchema.parse(raw);
  return write(db, () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      modelsKey(provider),
      JSON.stringify(list),
    );
    logAction(db, {
      agentId: actor,
      action: 'models_updated',
      description: `${provider} model list: ${list.map((m) => m.id).join(', ') || 'empty'}`,
      tags: ['models', provider],
    });
    return list;
  });
}

/** Slice 1 names, kept: Claude Code's list. */
export const getClaudeModels = (db: Db): ModelOption[] => getModelList(db, 'claude-code');
export const setClaudeModels = (db: Db, raw: unknown, actor = 'operator'): ModelOption[] =>
  setModelList(db, 'claude-code', raw, actor);

/** Can this agent run on a model/provider? Only text-runner agents can (not the operator, system, external or human). */
export const canChooseModel = (a: Pick<Agent, 'id' | 'type' | 'executor'>): boolean =>
  a.executor === 'agent' && a.type !== 'human' && a.id !== 'operator' && a.id !== 'system';

/** The provider an agent's tasks run on when the task does not override it. */
export const agentProvider = (a: Pick<Agent, 'provider'>): ProviderId =>
  a.provider && isProviderId(a.provider) ? a.provider : DEFAULT_PROVIDER;

const refuse = (agent: Agent) =>
  new CoreError(
    'MODEL_NOT_APPLICABLE',
    `${agent.name} is ${agent.executor === 'agent' ? 'a built-in actor' : `done by ${agent.executor === 'human' ? 'a person' : 'an external tool'}`}, so it has no model or provider.`,
  );

/**
 * Set (or clear with null) an agent's model. The id must be on its provider's list (local models are whatever the
 * server has, so any id is accepted there); an agent that cannot run on a model is refused. Writes an `agent_model_changed` entry.
 */
export function setAgentModel(
  db: Db,
  agentId: string,
  model: string | null,
  actor = 'operator',
): Agent {
  const id = model === null || model.trim() === '' ? null : model.trim();
  return write(db, () => {
    const agent = getAgent(db, agentId);
    if (!agent) throw new AgentNotFoundError(agentId);
    if (!canChooseModel(agent)) throw refuse(agent);
    const provider = agentProvider(agent);
    if (id !== null && provider !== 'local') {
      const list = getModelList(db, provider);
      if (!list.some((m) => m.id === id))
        throw new InvalidInputError(
          `Model "${id}" is not on the ${provider} model list (${list.map((m) => m.id).join(', ') || 'empty'}). Add it in Settings first.`,
        );
    }
    db.prepare('UPDATE agents SET model = ? WHERE id = ?').run(id, agentId);
    logAction(db, {
      agentId: actor,
      action: 'agent_model_changed',
      targetType: 'agent',
      targetId: agentId,
      description: `${agent.name}: model ${agent.model ?? 'default'} -> ${id ?? 'default'}`,
      tags: ['model', agentId],
    });
    const updated = getAgent(db, agentId);
    if (!updated) throw new AgentNotFoundError(agentId);
    return updated;
  });
}

/**
 * Route an agent to a provider (null = claude-code). The model is cleared, because model ids differ per provider.
 * Writes an `agent_provider_changed` entry.
 */
export function setAgentProvider(
  db: Db,
  agentId: string,
  provider: string | null,
  actor = 'operator',
): Agent {
  const next = provider === null || provider.trim() === '' ? null : provider.trim();
  if (next !== null && !isProviderId(next))
    throw new InvalidInputError(`Unknown provider "${next}". Use ${PROVIDER_IDS.join(', ')}.`);
  return write(db, () => {
    const agent = getAgent(db, agentId);
    if (!agent) throw new AgentNotFoundError(agentId);
    if (!canChooseModel(agent)) throw refuse(agent);
    const before = agentProvider(agent);
    const stored = next === DEFAULT_PROVIDER ? null : next;
    db.prepare('UPDATE agents SET provider = ?, model = NULL WHERE id = ?').run(stored, agentId);
    logAction(db, {
      agentId: actor,
      action: 'agent_provider_changed',
      targetType: 'agent',
      targetId: agentId,
      description: `${agent.name}: provider ${before} -> ${next ?? DEFAULT_PROVIDER}${agent.model ? ` (model ${agent.model} cleared)` : ''}`,
      tags: ['provider', agentId],
    });
    const updated = getAgent(db, agentId);
    if (!updated) throw new AgentNotFoundError(agentId);
    return updated;
  });
}

/** How many runs an agent may have at once (1-8). */
export function setAgentMaxConcurrent(
  db: Db,
  agentId: string,
  n: number,
  actor = 'operator',
): Agent {
  const count = z.number().int().min(1).max(8).parse(n);
  return write(db, () => {
    const agent = getAgent(db, agentId);
    if (!agent) throw new AgentNotFoundError(agentId);
    if (!canChooseModel(agent)) throw refuse(agent);
    db.prepare('UPDATE agents SET max_concurrent = ? WHERE id = ?').run(count, agentId);
    logAction(db, {
      agentId: actor,
      action: 'agent_concurrency_changed',
      targetType: 'agent',
      targetId: agentId,
      description: `${agent.name}: at most ${count} run${count === 1 ? '' : 's'} at once`,
      tags: ['concurrency', agentId],
    });
    const updated = getAgent(db, agentId);
    if (!updated) throw new AgentNotFoundError(agentId);
    return updated;
  });
}

export interface ResolvedModel {
  /** Passed to the provider, or null for its default (no `--model` flag for Claude Code). */
  model: string | null;
  /** Set when the agent's model is no longer on its provider's list: the run falls back to the default. */
  warning: string | null;
}

/** The model a run for this agent should use. A removed id falls back to the default with a warning, never an error. */
export function resolveAgentModel(db: Db, agentId: string): ResolvedModel {
  const agent = getAgent(db, agentId);
  if (!agent || !agent.model) return { model: null, warning: null };
  const provider = agentProvider(agent);
  if (provider === 'local' || getModelList(db, provider).some((m) => m.id === agent.model))
    return { model: agent.model, warning: null };
  return {
    model: null,
    warning: `${agent.name}: model "${agent.model}" is no longer on the ${provider} model list, using the default.`,
  };
}
