import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAgent } from '../src/agents';
import { openDb } from '../src/db';
import {
  canChooseModel,
  DEFAULT_CLAUDE_MODELS,
  getClaudeModels,
  resolveAgentModel,
  setAgentModel,
  setClaudeModels,
} from '../src/models';
import { getActivityFeed, getAgent } from '../src/queries';
import { tmpDb } from './helpers';

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
  registerAgent(t.db, { id: 'writer', name: 'Writer', type: 'sub-agent' });
  registerAgent(t.db, {
    id: 'voice',
    name: 'Voice',
    type: 'sub-agent',
    executor: 'external',
    tool: 'Voice tool',
  });
});
afterEach(() => t.cleanup());

describe('model list (settings)', () => {
  it('ships three starter aliases and stores edits', () => {
    expect(getClaudeModels(t.db).map((m) => m.id)).toEqual(['haiku', 'sonnet', 'opus']);
    expect(DEFAULT_CLAUDE_MODELS).toHaveLength(3);
    setClaudeModels(t.db, [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }]);
    expect(getClaudeModels(t.db)).toEqual([{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }]);
    expect(getActivityFeed(t.db, { limit: 1 })[0]?.action).toBe('models_updated');
  });

  it('rejects duplicates, spaces and unknown keys; an empty list is allowed', () => {
    expect(() =>
      setClaudeModels(t.db, [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'B' },
      ]),
    ).toThrow(/duplicate id/);
    expect(() => setClaudeModels(t.db, [{ id: 'a b', label: 'A' }])).toThrow(/no spaces/);
    expect(() => setClaudeModels(t.db, [{ id: 'a', label: 'A', extra: 1 }])).toThrow();
    expect(setClaudeModels(t.db, [])).toEqual([]);
    expect(getClaudeModels(t.db)).toEqual([]);
  });

  it('a corrupt stored value falls back to the starter list instead of failing', () => {
    t.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('claude.models', '{nope')")
      .run();
    expect(getClaudeModels(t.db).map((m) => m.id)).toEqual(['haiku', 'sonnet', 'opus']);
  });
});

describe('agent model', () => {
  it('sets, logs and clears an agent model; a new agent starts on the CLI default', () => {
    expect(getAgent(t.db, 'writer')?.model).toBeNull();
    expect(setAgentModel(t.db, 'writer', 'opus').model).toBe('opus');
    const log = getActivityFeed(t.db, { targetId: 'writer', limit: 1 })[0];
    expect(log).toMatchObject({ action: 'agent_model_changed', agent_id: 'operator' });
    expect(log?.description).toBe('Writer: model CLI default -> opus');
    expect(setAgentModel(t.db, 'writer', null).model).toBeNull();
    expect(setAgentModel(t.db, 'writer', '  ').model).toBeNull();
  });

  it('refuses ids that are not on the list, unknown agents, and agents that have no model', () => {
    expect(() => setAgentModel(t.db, 'writer', 'gpt-9')).toThrow(/not on the model list/);
    expect(() => setAgentModel(t.db, 'ghost', 'opus')).toThrow(/not registered/);
    expect(() => setAgentModel(t.db, 'voice', 'opus')).toThrow(/external tool/);
    expect(() => setAgentModel(t.db, 'operator', 'opus')).toThrow(/no model/);
    expect(() => setAgentModel(t.db, 'system', 'opus')).toThrow(/no model/);
    expect(canChooseModel({ id: 'writer', type: 'sub-agent', executor: 'agent' })).toBe(true);
    expect(canChooseModel({ id: 'voice', type: 'sub-agent', executor: 'external' })).toBe(false);
  });

  it('resolve: the model when listed, the CLI default for none, and a warning (not an error) when removed', () => {
    expect(resolveAgentModel(t.db, 'writer')).toEqual({ model: null, warning: null });
    expect(resolveAgentModel(t.db, 'nobody')).toEqual({ model: null, warning: null });
    setAgentModel(t.db, 'writer', 'sonnet');
    expect(resolveAgentModel(t.db, 'writer')).toEqual({ model: 'sonnet', warning: null });
    setClaudeModels(t.db, [{ id: 'opus', label: 'Opus' }]);
    const r = resolveAgentModel(t.db, 'writer');
    expect(r.model).toBeNull();
    expect(r.warning).toBe(
      'Writer: model "sonnet" is no longer on the model list, using the CLI default.',
    );
    expect(getAgent(t.db, 'writer')?.model).toBe('sonnet');
  });
});

describe('migration 007', () => {
  it('adds a nullable model column to an existing 006 database without touching agents', () => {
    t.db.exec(
      'ALTER TABLE agents DROP COLUMN model; DELETE FROM schema_version WHERE version = 7;',
    );
    const again = openDb(t.root);
    try {
      expect(getAgent(again, 'writer')).toMatchObject({ id: 'writer', model: null });
      expect(getAgent(again, 'operator')?.model).toBeNull();
    } finally {
      again.close();
    }
  });
});
