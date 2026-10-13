import { getOrchestratorMode, openDb, setOrchestratorConfig, type Db } from '@command-center/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orchestrateCommand, runsCommand } from '../src/commands';
import type { Handle } from '../src/context';

let root: string;
let db: Db;
let h: Handle;
const lines: string[] = [];
const out = (l: string) => lines.push(l);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-orch-'));
  db = openDb(root);
  h = { db, root } as unknown as Handle;
  lines.length = 0;
  db.prepare("INSERT INTO milestones (id, title) VALUES ('M0', 'T')").run();
  db.prepare("INSERT INTO subtasks (id, milestone_id, label) VALUES ('TASK-001', 'M0', 'x')").run();
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('command-center orchestrate', () => {
  it('shows the state by default, and --pause / --resume flip the shared mode', () => {
    orchestrateCommand(h, {}, out);
    expect(lines[0]).toBe('Orchestrator: off');
    expect(lines.join('\n')).toMatch(
      /Running 0 \/ 2 · queued 0[\s\S]*last hour: 0 \/ 20[\s\S]*\$0\.00 \/ \$5\.00/,
    );
    lines.length = 0;
    orchestrateCommand(h, { resume: true }, out);
    expect(getOrchestratorMode(db)).toBe('running');
    expect(lines[0]).toMatch(/^Resumed/);
    lines.length = 0;
    orchestrateCommand(h, { pause: true }, out);
    expect(getOrchestratorMode(db)).toBe('paused');
    expect(lines.join('\n')).toContain('Orchestrator: paused');
    expect(() => orchestrateCommand(h, { pause: true, resume: true }, out)).toThrow(/only one/);
  });

  it('says so when a cap is what stops dispatch, and --json is machine-readable', () => {
    setOrchestratorConfig(db, { maxPerHour: 1 });
    db.prepare("INSERT INTO agents (id, name, type) VALUES ('w', 'W', 'sub-agent')").run();
    db.prepare(
      `INSERT INTO runs (id, task_id, agent_id, provider, status, queued_at, started_at) VALUES ('r1', 'TASK-001', 'w', 'local', 'succeeded', ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    orchestrateCommand(h, { status: true }, out);
    expect(lines.join('\n')).toMatch(/PAUSED BY CAP \(hourly\)/);
    lines.length = 0;
    orchestrateCommand(h, { json: true }, out);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      mode: 'off',
      pausedByCap: 'hourly',
      config: { maxPerHour: 1 },
    });
  });
});

describe('command-center runs', () => {
  it('lists runs for a task with provider, model, tokens and an estimate label; unknown tasks are an error', () => {
    db.prepare("INSERT INTO agents (id, name, type) VALUES ('w', 'W', 'sub-agent')").run();
    const ins = db.prepare(
      `INSERT INTO runs (id, task_id, agent_id, provider, model, status, queued_at, started_at, finished_at, input_tokens, output_tokens, est_cost_usd, cost_basis)
       VALUES (?, 'TASK-001', 'w', ?, ?, 'succeeded', '2026-03-12T09:00:00Z', '2026-03-12T09:00:00Z', '2026-03-12T09:00:42Z', 100, 20, ?, ?)`,
    );
    ins.run('aaaaaaaa-1', 'claude-code', 'opus', 0.0123, 'reported');
    ins.run('bbbbbbbb-2', 'anthropic-api', 'claude-sonnet-5-5', 0.0042, 'estimate');
    runsCommand(h, { task: 'task-001', limit: 20 }, out);
    const text = lines.join('\n');
    expect(text).toContain('claude-code/opus');
    expect(text).toContain('anthropic-api/claude-sonnet-5-5');
    expect(text).toContain('42s');
    expect(text).toContain('$0.01');
    expect(text).toMatch(/\$0\.0042 \(est\.\)/);
    expect(() => runsCommand(h, { task: 'TASK-404', limit: 5 }, out)).toThrow(/does not exist/);
    lines.length = 0;
    runsCommand(h, { limit: 5, json: true }, out);
    expect(JSON.parse(lines[0] as string)).toHaveLength(2);
  });
});
