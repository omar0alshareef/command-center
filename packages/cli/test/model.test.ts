import {
  getActivityFeed,
  getAgent,
  getTask,
  openDb,
  registerAgent,
  setAgentModel,
  setClaudeModels,
  type Db,
} from '@command-center/core';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeArgs } from '../src/pipeline/claude';
import type { Runner, StageRequest } from '../src/pipeline/runner';
import { ensurePipelineAgents, runStage, warnModels } from '../src/pipeline/runtime';
import { STAGES } from '../src/pipeline/stages';

let root: string;
let db: Db;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-model-'));
  mkdirSync(join(root, 'src'));
  db = openDb(root);
  ensurePipelineAgents(db);
  db.prepare("INSERT INTO milestones (id, title) VALUES ('M0', 'Test')").run();
  db.prepare(
    "INSERT INTO subtasks (id, milestone_id, label) VALUES ('TASK-001', 'M0', 'Add login')",
  ).run();
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** A runner that records the request it was given and answers with a fixed text. */
function spy(): { runner: Runner; seen: StageRequest[] } {
  const seen: StageRequest[] = [];
  return {
    seen,
    runner: {
      name: 'spy',
      run: (req) => {
        seen.push(req);
        return Promise.resolve({ ok: true, output: 'done' });
      },
    },
  };
}
const run = (runner: Runner, stage = STAGES.explorer) => {
  const task = getTask(db, 'TASK-001');
  if (!task) throw new Error('task missing');
  return runStage(db, runner, root, task, stage, {}, {}, () => ({ summary: 'ok' }));
};
const lastLog = () => getActivityFeed(db, { targetId: 'TASK-001', limit: 5 })[0];

describe('claude args', () => {
  it('passes --model <id> when the agent has a model, and nothing when it is empty', () => {
    const withModel = claudeArgs({ stage: STAGES.explorer, model: 'opus', systemFile: 's' });
    expect(withModel.slice(withModel.indexOf('--model'), withModel.indexOf('--model') + 2)).toEqual(
      ['--model', 'opus'],
    );
    expect(claudeArgs({ stage: STAGES.explorer, model: null, systemFile: 's' })).not.toContain(
      '--model',
    );
  });
  it('ignores the old COMMAND_CENTER_MODEL variable: the agent decides', () => {
    process.env['COMMAND_CENTER_MODEL'] = 'should-not-appear';
    try {
      expect(claudeArgs({ stage: STAGES.builder, model: null, systemFile: 's' })).not.toContain(
        '--model',
      );
    } finally {
      delete process.env['COMMAND_CENTER_MODEL'];
    }
  });
});

describe('per-agent model reaches the runner and the log', () => {
  it('two agents with different models: each run carries and logs its own', async () => {
    setAgentModel(db, 'research-explorer', 'haiku');
    setAgentModel(db, 'code-quality', 'opus');
    const { runner, seen } = spy();
    await run(runner, STAGES.explorer);
    const first = lastLog();
    await run(runner, STAGES.quality);
    const second = lastLog();
    expect(seen.map((r) => r.model)).toEqual(['haiku', 'opus']);
    expect(first?.agent_id).toBe('research-explorer');
    expect(first?.description).toContain('[model: haiku]');
    expect(second?.agent_id).toBe('code-quality');
    expect(second?.description).toContain('[model: opus]');
  });

  it('CLI default: an agent with no model runs without the flag, and says so in the log', async () => {
    setAgentModel(db, 'research-explorer', 'sonnet');
    const { runner, seen } = spy();
    await run(runner);
    setAgentModel(db, 'research-explorer', null);
    await run(runner);
    expect(seen.map((r) => r.model)).toEqual(['sonnet', null]);
    expect(lastLog()?.description).toContain('[model: CLI default]');
    expect(
      claudeArgs({ stage: STAGES.explorer, model: seen[1]?.model ?? null, systemFile: 's' }),
    ).not.toContain('--model');
  });

  it("the builder runs as the task assignee, so the assignee's model is used", async () => {
    registerAgent(db, { id: 'builder-bot', name: 'Builder bot', type: 'sub-agent' });
    setAgentModel(db, 'builder-bot', 'opus');
    db.prepare("UPDATE subtasks SET assignee = 'builder-bot' WHERE id = 'TASK-001'").run();
    const { runner, seen } = spy();
    await run(runner, STAGES.builder);
    expect(seen[0]?.model).toBe('opus');
  });

  it('a model removed from the list does not crash: CLI default, a warning in the log and on screen', async () => {
    setAgentModel(db, 'research-explorer', 'opus');
    setClaudeModels(db, [{ id: 'sonnet', label: 'Sonnet' }]);
    const { runner, seen } = spy();
    const r = await run(runner);
    expect(r.result.ok).toBe(true);
    expect(seen[0]?.model).toBeNull();
    expect(r.warning).toContain('no longer on the model list');
    expect(getAgent(db, 'research-explorer')?.model).toBe('opus'); // the stored choice is untouched
    const log = getActivityFeed(db, { targetId: 'TASK-001', limit: 5 });
    expect(log.some((l) => l.action === 'model_unavailable')).toBe(true);
    const lines: string[] = [];
    warnModels(db, (l) => lines.push(l), [
      'research-explorer',
      'research-explorer',
      'code-quality',
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^warning: .*"opus"/);
  });
});
