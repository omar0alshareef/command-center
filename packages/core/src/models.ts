import { z } from 'zod';
import { write, type Db } from './db';
import { AgentNotFoundError, CoreError, InvalidInputError } from './errors';
import { getAgent, logAction } from './queries';
import type { Agent } from './types';

// M14 Slice 1: which Claude Code model an agent runs on. Names are never hardcoded in code paths: the list lives
// in the `settings` table as an editable JSON array, seeded here with the aliases the installed `claude` accepts.

export const CLAUDE_MODELS_KEY = 'claude.models';

export const ModelOptionSchema = z.strictObject({
  /** What is passed to `claude --model` (an alias such as `sonnet`, or a full model name). */
  id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:\-[\]]*$/, 'use letters, digits and . _ : - [ ] (no spaces)'),
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

function readSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

/** The model list: the stored one when it is valid JSON of the right shape, else the starter entries. */
export function getClaudeModels(db: Db): ModelOption[] {
  const raw = readSetting(db, CLAUDE_MODELS_KEY);
  if (raw === null) return DEFAULT_CLAUDE_MODELS.map((m) => ({ ...m }));
  try {
    const parsed = ModelListSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through to the defaults */
  }
  return DEFAULT_CLAUDE_MODELS.map((m) => ({ ...m }));
}

/** Replace the model list. Validates the shape and rejects duplicate ids; an empty list is allowed ("CLI default" only). */
export function setClaudeModels(db: Db, raw: unknown, actor = 'operator'): ModelOption[] {
  const list = ModelListSchema.parse(raw);
  return write(db, () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      CLAUDE_MODELS_KEY,
      JSON.stringify(list),
    );
    logAction(db, {
      agentId: actor,
      action: 'models_updated',
      description: `Claude Code model list: ${list.map((m) => m.id).join(', ') || 'empty'}`,
      tags: ['models'],
    });
    return list;
  });
}

/** Can this agent run on a Claude Code model? Only text-runner agents can (not the operator, system, external or human). */
export const canChooseModel = (a: Pick<Agent, 'id' | 'type' | 'executor'>): boolean =>
  a.executor === 'agent' && a.type !== 'human' && a.id !== 'operator' && a.id !== 'system';

/**
 * Set (or clear with null) an agent's model. The id must be on the current list; an agent that cannot run on
 * a model is refused. Writes an `agent_model_changed` entry.
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
    if (!canChooseModel(agent))
      throw new CoreError(
        'MODEL_NOT_APPLICABLE',
        `${agent.name} is ${agent.executor === 'agent' ? 'a built-in actor' : `done by ${agent.executor === 'human' ? 'a person' : 'an external tool'}`}, so it has no model.`,
      );
    if (id !== null && !getClaudeModels(db).some((m) => m.id === id))
      throw new InvalidInputError(
        `Model "${id}" is not on the model list (${
          getClaudeModels(db)
            .map((m) => m.id)
            .join(', ') || 'empty'
        }). Add it in Settings first.`,
      );
    db.prepare('UPDATE agents SET model = ? WHERE id = ?').run(id, agentId);
    logAction(db, {
      agentId: actor,
      action: 'agent_model_changed',
      targetType: 'agent',
      targetId: agentId,
      description: `${agent.name}: model ${agent.model ?? 'CLI default'} -> ${id ?? 'CLI default'}`,
      tags: ['model', agentId],
    });
    const updated = getAgent(db, agentId);
    if (!updated) throw new AgentNotFoundError(agentId);
    return updated;
  });
}

export interface ResolvedModel {
  /** Passed to `--model`, or null for the CLI default (no flag). */
  model: string | null;
  /** Set when the agent's model is no longer on the list: the run falls back to the CLI default. */
  warning: string | null;
}

/** The model a run for this agent should use. A removed id falls back to the CLI default with a warning, never an error. */
export function resolveAgentModel(db: Db, agentId: string): ResolvedModel {
  const agent = getAgent(db, agentId);
  if (!agent || !agent.model) return { model: null, warning: null };
  if (getClaudeModels(db).some((m) => m.id === agent.model))
    return { model: agent.model, warning: null };
  return {
    model: null,
    warning: `${agent.name}: model "${agent.model}" is no longer on the model list, using the CLI default.`,
  };
}
