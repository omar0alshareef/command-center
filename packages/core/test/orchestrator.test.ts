import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAgent } from '../src/agents';
import { setAgentModel, setAgentProvider } from '../src/models';
import {
  extractSummary,
  Orchestrator,
  orchestratorStatus,
  parseVerdict,
  readyTasks,
  routeTask,
} from '../src/orchestrator';
import {
  getOrchestratorConfig,
  getOrchestratorMode,
  setOrchestratorConfig,
  setOrchestratorMode,
} from '../src/orchestrator-settings';
import {
  buildProviders,
  PROVIDER_IDS,
  ProviderError,
  type ProviderAdapter,
  type ProviderId,
  type ProviderRunInput,
  type ProviderRunResult,
} from '../src/providers';
import { getActivityFeed, getAgent, getTask, listRuns } from '../src/queries';
import { cancelRun } from '../src/runs';
import { transition } from '../src/state-machine';
import { toJson } from '../src/types';
import { tmpDb } from './helpers';

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
  t.db
    .prepare(
      "INSERT INTO milestones (id, title, planned_start) VALUES ('M1', 'First', '2026-01-05')",
    )
    .run();
  t.db
    .prepare(
      "INSERT INTO milestones (id, title, planned_start) VALUES ('M2', 'Second', '2026-02-02')",
    )
    .run();
  for (const id of ['alpha', 'beta', 'gamma'])
    registerAgent(t.db, { id, name: id[0]?.toUpperCase() + id.slice(1), type: 'sub-agent' });
  registerAgent(t.db, {
    id: 'voice',
    name: 'Voice',
    type: 'sub-agent',
    executor: 'external',
    tool: 'Voice tool',
  });
});
afterEach(() => t.cleanup());

let n = 0;
function task(
  id: string,
  o: {
    assignee?: string | null;
    deps?: string[];
    milestone?: string;
    priority?: string;
    due?: string | null;
    status?: string;
    mode?: string;
    override?: string | null;
  } = {},
): string {
  t.db
    .prepare(
      `INSERT INTO subtasks (id, milestone_id, label, status, priority, assignee, depends_on, due_date, execution_mode, provider_override)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      o.milestone ?? 'M1',
      `Task ${id} ${n++}`,
      o.status ?? 'todo',
      o.priority ?? 'P2',
      o.assignee === undefined ? 'alpha' : o.assignee,
      toJson(o.deps ?? []),
      o.due ?? null,
      o.mode ?? 'agent',
      o.override ?? null,
    );
  return id;
}

type Behaviour = (input: ProviderRunInput, call: number) => Promise<ProviderRunResult>;
const ok = (
  output = 'Did it.\nSUMMARY: all done',
  extra: Partial<ProviderRunResult> = {},
): ProviderRunResult => ({
  output,
  truncated: false,
  exitCode: 0,
  usage: { inputTokens: 100, outputTokens: 20, costUsd: null },
  ...extra,
});
/** An adapter whose behaviour the test controls. `calls` records every input it received. */
function fake(
  id: ProviderId,
  behaviour: Behaviour = () => Promise.resolve(ok()),
  detect = { available: true, detail: 'fake' },
): ProviderAdapter & { calls: ProviderRunInput[] } {
  const calls: ProviderRunInput[] = [];
  return {
    id,
    label: id,
    kind: 'api',
    needsKey: false,
    defaultModel: id === 'claude-code' ? null : 'fake-model', // like the real adapters: the CLI has no default id to record
    calls,
    detect: () => Promise.resolve(detect),
    test: () => Promise.resolve({ ok: true, detail: 'ok' }),
    run: (input) => {
      calls.push(input);
      return behaviour(input, calls.length);
    },
  };
}
/** Hangs until aborted, like a long CLI run. */
const hang: Behaviour = (input) =>
  new Promise((_, reject) => {
    const stop = () => reject(new ProviderError('cancelled', 'Cancelled.'));
    if (input.signal.aborted) stop();
    input.signal.addEventListener('abort', stop);
  });

function orchestrator(
  adapters: Partial<Record<ProviderId, ProviderAdapter>> = {},
  o: { getKey?: (id: ProviderId) => string | null; now?: () => Date } = {},
) {
  const real = buildProviders({
    fetch,
    baseUrl: () => undefined,
    findBinary: () => null,
    apiKey: () => null,
  });
  const providers = { ...real, ...adapters } as Record<ProviderId, ProviderAdapter>;
  for (const id of PROVIDER_IDS) providers[id] ??= real[id];
  return new Orchestrator({
    db: t.db,
    projectRoot: t.root,
    providers,
    getKey: o.getKey ?? (() => null),
    ...(o.now ? { now: o.now } : {}),
  });
}
const go = async (o: Orchestrator) => {
  await o.refreshProviders();
  setOrchestratorMode(t.db, 'running');
};
/** Approve a task in Review as the operator, so dependants become ready. */
const approve = (id: string) => transition(t.db, id, 'approve');

describe('readyTasks (D22)', () => {
  it('needs To Do, an agent assignee, every dependency done and no run in flight', () => {
    task('A');
    task('B', { deps: ['A'] });
    task('C', { assignee: null });
    task('D', { assignee: 'voice' });
    task('E', { assignee: 'operator' });
    task('F', { mode: 'human' });
    task('G', { status: 'blocked' });
    task('H', { deps: ['NOPE'] });
    expect(readyTasks(t.db).map((x) => x.id)).toEqual(['A', 'F'].filter((x) => x !== 'F'));
  });

  it('a dependency chain of three: only the first is ready, then the second, then the third', () => {
    task('T1');
    task('T2', { deps: ['T1'] });
    task('T3', { deps: ['T1', 'T2'] });
    expect(readyTasks(t.db).map((x) => x.id)).toEqual(['T1']);
    t.db.prepare("UPDATE subtasks SET status = 'done' WHERE id = 'T1'").run();
    expect(readyTasks(t.db).map((x) => x.id)).toEqual(['T2']);
    t.db.prepare("UPDATE subtasks SET status = 'done' WHERE id = 'T2'").run();
    expect(readyTasks(t.db).map((x) => x.id)).toEqual(['T3']);
  });

  it('orders by milestone start, then priority, then due date, then id', () => {
    task('Z1', { milestone: 'M2', priority: 'P0' });
    task('B2', { priority: 'P2', due: '2026-03-01' });
    task('B1', { priority: 'P2', due: '2026-02-01' });
    task('B0', { priority: 'P2', due: null });
    task('A9', { priority: 'P0' });
    expect(readyTasks(t.db).map((x) => x.id)).toEqual(['A9', 'B1', 'B2', 'B0', 'Z1']);
  });

  it('skips tasks whose provider is not available, and a task with a run in flight', () => {
    task('A');
    task('B', { assignee: 'beta' });
    setAgentProvider(t.db, 'beta', 'openai-api');
    expect(readyTasks(t.db, new Set<ProviderId>(['claude-code'])).map((x) => x.id)).toEqual(['A']);
    t.db
      .prepare(
        "INSERT INTO runs (id, task_id, agent_id, provider, status, queued_at) VALUES ('r1', 'A', 'alpha', 'claude-code', 'running', '2026-01-01T00:00:00Z')",
      )
      .run();
    expect(readyTasks(t.db).map((x) => x.id)).toEqual(['B']);
  });

  it('routing: the task override beats the agent default; unknown providers do not route', () => {
    task('A');
    task('B', { override: 'local' });
    task('C', { override: 'telepathy' });
    setAgentProvider(t.db, 'alpha', 'anthropic-api');
    const route = (id: string) => routeTask(t.db, getTask(t.db, id) as never);
    expect(route('A')?.provider).toBe('anthropic-api');
    expect(route('B')?.provider).toBe('local');
    expect(route('C')).toBeNull();
    expect(route('B')?.agent.id).toBe('alpha');
  });
});

describe('dispatch loop', () => {
  it('chain of three: the first runs; completing it dispatches the second; the third waits for both', async () => {
    const a = fake('claude-code');
    const o = orchestrator({ 'claude-code': a });
    task('T1');
    task('T2', { deps: ['T1'] });
    task('T3', { deps: ['T1', 'T2'] });
    await go(o);
    expect(o.tick()).toHaveLength(1);
    await o.idle();
    expect(a.calls).toHaveLength(1);
    expect(getTask(t.db, 'T1')?.status).toBe('review'); // the agent completed it: waiting for a person
    expect(o.tick()).toEqual([]); // T2 still waits: T1 is not done
    approve('T1');
    expect(o.tick()).toHaveLength(1);
    await o.idle();
    expect(getTask(t.db, 'T2')?.status).toBe('review');
    expect(getTask(t.db, 'T3')?.status).toBe('todo');
    approve('T2');
    expect(o.tick()).toHaveLength(1);
    await o.idle();
    expect(
      listRuns(t.db)
        .map((r) => r.task_id)
        .sort(),
    ).toEqual(['T1', 'T2', 'T3']);
  });

  it('records the run (provider, model, tokens, duration) and logs it; the summary becomes the completion', async () => {
    const o = orchestrator({
      'claude-code': fake('claude-code', () =>
        Promise.resolve(
          ok('Report.\nSUMMARY: wired the form', {
            usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.0123 },
          }),
        ),
      ),
    });
    task('T1');
    setAgentModel(t.db, 'alpha', 'opus');
    await go(o);
    o.tick();
    await o.idle();
    const [run] = listRuns(t.db);
    expect(run).toMatchObject({
      task_id: 'T1',
      agent_id: 'alpha',
      provider: 'claude-code',
      model: 'opus',
      kind: 'work',
      status: 'succeeded',
      exit_code: 0,
      input_tokens: 1200,
      output_tokens: 300,
      est_cost_usd: 0.0123,
      cost_basis: 'reported',
    });
    expect(run?.output_tail).toContain('SUMMARY: wired the form');
    const finished = getActivityFeed(t.db, { targetId: 'T1', limit: 20 }).find(
      (l) => l.action === 'run_finished',
    );
    expect(finished?.description).toMatch(
      /work run succeeded on claude-code\/opus in \d+ s · exit 0 · 1200 in \/ 300 out tokens · \$0\.0123 \(reported\)/,
    );
    expect(finished?.tags).toContain(run?.id);
    const completed = getActivityFeed(t.db, { targetId: 'T1', limit: 20 }).find(
      (l) => l.action === 'task_completed',
    );
    expect(completed?.description).toContain('wired the form');
  });

  it('routing: two agents on two providers each run on their own adapter; a task override wins', async () => {
    const local = fake('local');
    const anthropic = fake('anthropic-api');
    const openai = fake('openai-api');
    const o = orchestrator({ local, 'anthropic-api': anthropic, 'openai-api': openai });
    setAgentProvider(t.db, 'alpha', 'local');
    setAgentProvider(t.db, 'beta', 'anthropic-api');
    task('A', { assignee: 'alpha' });
    task('B', { assignee: 'beta' });
    task('C', { assignee: 'gamma', override: 'openai-api' });
    setOrchestratorConfig(t.db, { maxConcurrent: 5 });
    await go(o);
    o.tick();
    await o.idle();
    const byTask = Object.fromEntries(listRuns(t.db).map((r) => [r.task_id, r.provider]));
    expect(byTask).toEqual({ A: 'local', B: 'anthropic-api', C: 'openai-api' });
    expect([local.calls.length, anthropic.calls.length, openai.calls.length]).toEqual([1, 1, 1]);
  });

  it('an estimate is labelled as one: tokens and a price table, never a reported cost', async () => {
    const o = orchestrator({
      'anthropic-api': fake('anthropic-api', () =>
        Promise.resolve(
          ok('x\nSUMMARY: s', {
            usage: { inputTokens: 1_000_000, outputTokens: 100_000, costUsd: null },
            model: 'claude-sonnet-5-5',
          }),
        ),
      ),
    });
    setAgentProvider(t.db, 'alpha', 'anthropic-api');
    task('T1');
    await go(o);
    o.tick();
    await o.idle();
    const run = listRuns(t.db)[0];
    expect(run?.cost_basis).toBe('estimate');
    expect(run?.est_cost_usd).toBeCloseTo(3 + 1.5, 5);
  });

  it('a provider that is not detected is never routed to; manual start explains why', async () => {
    const o = orchestrator({
      local: fake('local', undefined, { available: false, detail: 'no server' }),
    });
    setAgentProvider(t.db, 'alpha', 'local');
    task('T1');
    await go(o);
    expect(o.tick()).toEqual([]);
    expect(o.status().queued).toBe(0);
    expect(() => o.dispatch('T1')).toThrow(/local is not detected \(no server\)/);
    expect(o.status().providers.find((p) => p.id === 'local')).toMatchObject({
      available: false,
      detail: 'no server',
    });
  });

  it('nothing runs until the orchestrator is switched on; paused and off dispatch nothing', async () => {
    const a = fake('claude-code');
    const o = orchestrator({ 'claude-code': a });
    task('T1');
    await o.refreshProviders();
    expect(getOrchestratorMode(t.db)).toBe('off');
    expect(o.tick()).toEqual([]);
    expect(o.status().queued).toBe(1);
    o.resume();
    expect(o.tick()).toHaveLength(1);
    await o.idle();
    task('T2');
    o.pause();
    expect(o.tick()).toEqual([]);
    expect(a.calls).toHaveLength(1);
  });

  it('manual start uses the same path, ignores a paused orchestrator, and respects dependencies unless forced', async () => {
    const a = fake('claude-code');
    const o = orchestrator({ 'claude-code': a });
    task('T1');
    task('T2', { deps: ['T1'] });
    await o.refreshProviders();
    expect(() => o.dispatch('T2')).toThrow(/depends on T1/);
    expect(() => o.dispatch('T2', { force: true })).not.toThrow();
    o.dispatch('T1');
    await o.idle();
    expect(a.calls).toHaveLength(2);
    expect(() => o.dispatch('T1')).toThrow(/review; only a To Do task/);
    task('P', { assignee: 'voice' });
    expect(() => o.dispatch('P')).toThrow(/no agent to run it/);
  });
});

describe('caps and concurrency (D28)', () => {
  it('hourly cap of 2: the third ready task is queued, the status says paused by cap, nothing starts until it is raised', async () => {
    const a = fake('claude-code');
    const o = orchestrator({ 'claude-code': a });
    task('A', { assignee: 'alpha' });
    task('B', { assignee: 'beta' });
    task('C', { assignee: 'gamma' });
    setOrchestratorConfig(t.db, { maxPerHour: 2, maxConcurrent: 5 });
    await go(o);
    expect(o.tick()).toHaveLength(2);
    await o.idle();
    expect(o.tick()).toEqual([]);
    const s = o.status();
    expect(s).toMatchObject({
      pausedByCap: 'hourly',
      startedLastHour: 2,
      maxPerHour: 2,
      queued: 1,
    });
    expect(getTask(t.db, 'C')?.status).toBe('todo');
    setOrchestratorConfig(t.db, { maxPerHour: 3 });
    expect(o.tick()).toHaveLength(1);
    await o.idle();
    expect(a.calls).toHaveLength(3);
  });

  it('the window clears: runs older than an hour no longer count', async () => {
    let clock = new Date('2026-03-10T10:00:00Z');
    const o = orchestrator({ 'claude-code': fake('claude-code') }, { now: () => clock });
    for (const id of ['A', 'B']) task(id);
    setOrchestratorConfig(t.db, { maxPerHour: 1 });
    await go(o);
    expect(o.tick()).toHaveLength(1);
    await o.idle();
    const first = listRuns(t.db)[0];
    t.db
      .prepare('UPDATE runs SET started_at = ? WHERE id = ?')
      .run(new Date(clock.getTime()).toISOString(), first?.id);
    expect(o.tick()).toEqual([]);
    clock = new Date(clock.getTime() + 61 * 60_000);
    expect(o.tick()).toHaveLength(1);
    await o.idle();
  });

  it('a daily spend ceiling pauses dispatch once the estimate reaches it', async () => {
    const o = orchestrator({
      'claude-code': fake('claude-code', () =>
        Promise.resolve(
          ok('x\nSUMMARY: s', { usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.6 } }),
        ),
      ),
    });
    for (const id of ['A', 'B', 'C']) task(id);
    setOrchestratorConfig(t.db, { dailySpendUsd: 1, maxConcurrent: 1 });
    await go(o);
    for (let i = 0; i < 3; i++) {
      o.tick();
      await o.idle();
    }
    expect(listRuns(t.db)).toHaveLength(2); // 0.6 + 0.6 >= 1.0: the third never starts
    expect(o.status()).toMatchObject({ pausedByCap: 'daily', queued: 1 });
    expect(o.status().spendToday).toBeCloseTo(1.2, 5);
  });

  it('the concurrency limit queues the rest (no cap reason), and an agent limit of 1 serialises its tasks', async () => {
    const gates: (() => void)[] = [];
    const slow: Behaviour = () => new Promise((res) => gates.push(() => res(ok())));
    const o = orchestrator({ 'claude-code': fake('claude-code', slow) });
    task('A1', { assignee: 'alpha' });
    task('A2', { assignee: 'alpha' });
    task('B1', { assignee: 'beta' });
    task('G1', { assignee: 'gamma' });
    setOrchestratorConfig(t.db, { maxConcurrent: 2 });
    await go(o);
    const started = o.tick();
    expect(started).toHaveLength(2); // A1 (alpha) and B1 (beta); A2 waits for alpha, G1 for a slot
    expect(o.status()).toMatchObject({ running: 2, queued: 2, pausedByCap: null });
    expect(
      listRuns(t.db)
        .map((r) => r.agent_id)
        .sort(),
    ).toEqual(['alpha', 'beta']);
    gates.splice(0).forEach((g) => g());
    await o.idle();
    expect(o.tick()).toHaveLength(2);
    gates.splice(0).forEach((g) => g());
    await o.idle();
  });
});

describe('failure, retry, cancel, pause', () => {
  it('fails once then succeeds: one retry, two run rows, task completed', async () => {
    const o = orchestrator({
      'claude-code': fake('claude-code', (_i, call) =>
        call === 1
          ? Promise.reject(new ProviderError('failed', 'overloaded', 529))
          : Promise.resolve(ok()),
      ),
    });
    task('T1');
    await go(o);
    o.tick();
    await o.idle();
    expect(
      listRuns(t.db)
        .map((r) => `${r.attempt}:${r.status}`)
        .sort(),
    ).toEqual(['1:failed', '2:succeeded']);
    expect(getTask(t.db, 'T1')?.status).toBe('review');
  });

  it('a provider that times out is retried once, then the task is blocked with the error; other tasks still run', async () => {
    const slowFail: Behaviour = () =>
      Promise.reject(new ProviderError('timeout', 'Timed out after 900 s.'));
    const o = orchestrator({
      'claude-code': fake('claude-code', (i) =>
        i.prompt.includes('Task BAD') ? slowFail(i, 1) : Promise.resolve(ok()),
      ),
    });
    task('BAD');
    task('GOOD', { assignee: 'beta' });
    setOrchestratorConfig(t.db, { maxConcurrent: 3 });
    await go(o);
    o.tick();
    await o.idle();
    const bad = getTask(t.db, 'BAD');
    expect(bad?.status).toBe('blocked');
    expect(bad?.blocked_reason).toBe('Failed twice on claude-code: Timed out after 900 s.');
    expect(
      listRuns(t.db)
        .filter((r) => r.task_id === 'BAD')
        .map((r) => r.status),
    ).toEqual(['failed', 'failed']);
    expect(getTask(t.db, 'GOOD')?.status).toBe('review');
    expect(o.status().running).toBe(0);
  });

  it('an agent that reports "SUMMARY: BLOCKED - why" blocks the task without a retry', async () => {
    const a = fake('claude-code', () =>
      Promise.resolve(ok('I cannot.\nSUMMARY: BLOCKED - needs the API contract')),
    );
    const o = orchestrator({ 'claude-code': a });
    task('T1');
    await go(o);
    o.tick();
    await o.idle();
    expect(a.calls).toHaveLength(1);
    expect(getTask(t.db, 'T1')).toMatchObject({
      status: 'blocked',
      blocked_reason: 'needs the API contract',
    });
  });

  it('cancel aborts the run, marks it cancelled and blocks the task; slot is released', async () => {
    const a = fake('claude-code', hang);
    const o = orchestrator({ 'claude-code': a });
    task('T1');
    await go(o);
    const [runId] = o.tick();
    expect(o.status().running).toBe(1);
    expect(o.cancel(runId as string)).toBe(true);
    await o.idle();
    const run = listRuns(t.db)[0];
    expect(run).toMatchObject({ status: 'cancelled', error: 'Cancelled.' });
    expect(getTask(t.db, 'T1')).toMatchObject({
      status: 'blocked',
      blocked_reason: 'Run cancelled by the operator.',
    });
    expect(a.calls).toHaveLength(1); // no retry after a cancel
    expect(o.status().running).toBe(0);
    expect(o.cancel('nope')).toBe(false);
  });

  it('a cancel requested from another process (MCP, CLI) is picked up from the database', async () => {
    const o = orchestrator({ 'claude-code': fake('claude-code', hang) });
    task('T1');
    await go(o);
    const [runId] = o.tick();
    expect(cancelRun(t.db, runId as string, 'beta').cancel_requested).toBe(true);
    o.checkCancels();
    await o.idle();
    expect(listRuns(t.db)[0]?.status).toBe('cancelled');
    expect(() => cancelRun(t.db, runId as string)).toThrow(/already cancelled/);
  });

  it('pause stops new dispatches at once; "cancel running" aborts in-flight runs, "let them finish" does not', async () => {
    const gates: (() => void)[] = [];
    const o = orchestrator({
      'claude-code': fake('claude-code', () => new Promise((res) => gates.push(() => res(ok())))),
    });
    task('A');
    task('B', { assignee: 'beta' });
    task('C', { assignee: 'gamma' });
    setOrchestratorConfig(t.db, { maxConcurrent: 1 });
    await go(o);
    o.tick();
    o.pause();
    expect(getOrchestratorMode(t.db)).toBe('paused');
    expect(o.tick()).toEqual([]);
    expect(o.status().running).toBe(1);
    gates.splice(0).forEach((g) => g()); // let it finish
    await o.idle();
    expect(getTask(t.db, 'A')?.status).toBe('review');

    const o2 = orchestrator({ 'claude-code': fake('claude-code', hang) });
    await go(o2);
    o2.tick();
    o2.pause({ cancelRunning: true });
    await o2.idle();
    expect(getTask(t.db, 'B')?.status).toBe('blocked');
  });

  it('stop after current: no new runs, and the mode becomes paused when the last one ends', async () => {
    const gates: (() => void)[] = [];
    const o = orchestrator({
      'claude-code': fake('claude-code', () => new Promise((res) => gates.push(() => res(ok())))),
    });
    task('A');
    task('B', { assignee: 'beta' });
    setOrchestratorConfig(t.db, { maxConcurrent: 1 });
    await go(o);
    o.tick();
    expect(o.stopAfterCurrent()).toBe('draining');
    expect(o.tick()).toEqual([]);
    gates.splice(0).forEach((g) => g());
    await o.idle();
    expect(getOrchestratorMode(t.db)).toBe('paused');
    expect(getTask(t.db, 'B')?.status).toBe('todo');
  });

  it('a run left running by a crash is failed and its task blocked on the next start', async () => {
    task('T1', { status: 'in_progress' });
    t.db
      .prepare(
        "INSERT INTO runs (id, task_id, agent_id, provider, status, queued_at, started_at) VALUES ('old', 'T1', 'alpha', 'claude-code', 'running', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
      )
      .run();
    const o = orchestrator();
    expect(o.recoverStale()).toBe(1);
    expect(listRuns(t.db)[0]).toMatchObject({
      status: 'failed',
      error: 'The app closed during the run.',
    });
    expect(getTask(t.db, 'T1')).toMatchObject({
      status: 'blocked',
      blocked_reason: 'The app closed during the run.',
    });
  });
});

describe('model and prompt', () => {
  it("the run carries the agent's model; a removed model falls back to the default and logs a warning", async () => {
    const a = fake('claude-code');
    const o = orchestrator({ 'claude-code': a });
    setAgentModel(t.db, 'alpha', 'sonnet');
    t.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('claude.models', ?)")
      .run(JSON.stringify([{ id: 'opus', label: 'Opus' }]));
    task('T1');
    await go(o);
    o.tick();
    await o.idle();
    expect(a.calls[0]?.model).toBeNull();
    expect(
      getActivityFeed(t.db, { targetId: 'T1', limit: 20 }).some(
        (l) => l.action === 'model_unavailable',
      ),
    ).toBe(true);
    expect(getAgent(t.db, 'alpha')?.model).toBe('sonnet');
  });

  it('the prompt is the task context; claude-code may edit files, API providers get no edit permission', async () => {
    const cc = fake('claude-code');
    const api = fake('anthropic-api');
    const o = orchestrator({ 'claude-code': cc, 'anthropic-api': api });
    setAgentProvider(t.db, 'beta', 'anthropic-api');
    task('A');
    task('B', { assignee: 'beta' });
    setOrchestratorConfig(t.db, { maxConcurrent: 2 });
    await go(o);
    o.tick();
    await o.idle();
    expect(cc.calls[0]?.prompt).toContain('# A: Task A');
    expect(cc.calls[0]?.system).toContain('SUMMARY:');
    expect(cc.calls[0]?.allowEdits).toBe(true);
    expect(api.calls[0]?.allowEdits).toBe(false);
    expect(cc.calls[0]?.workdir).toBe(t.root);
  });
});

describe('reviewer rule (D29)', () => {
  it('the reviewer is never the executor or one of its family; another provider is preferred', async () => {
    registerAgent(t.db, {
      id: 'alpha-sub',
      name: 'Alpha sub',
      type: 'sub-agent',
      parent_id: 'alpha',
    });
    setAgentProvider(t.db, 'gamma', 'local');
    const o = orchestrator({ 'claude-code': fake('claude-code'), local: fake('local') });
    await o.refreshProviders();
    const alpha = getAgent(t.db, 'alpha');
    const picked = o.pickReviewer(alpha as never);
    expect(picked?.agent.id).toBe('gamma'); // other provider first
    expect(['alpha', 'alpha-sub']).not.toContain(picked?.agent.id);
    const only = orchestrator({ 'claude-code': fake('claude-code') });
    await only.refreshProviders();
    t.db.prepare("UPDATE agents SET executor = 'external' WHERE id = 'gamma'").run();
    expect(['beta']).toContain(only.pickReviewer(alpha as never)?.agent.id);
  });

  it('with auto review on, a different agent approves; it is applied through the same state machine', async () => {
    const reviewer = fake('anthropic-api', () =>
      Promise.resolve(ok('Looks right.\nVERDICT: APPROVE\nREASON: criteria met')),
    );
    const worker = fake('claude-code');
    const o = orchestrator({ 'claude-code': worker, 'anthropic-api': reviewer });
    setAgentProvider(t.db, 'beta', 'anthropic-api');
    setOrchestratorConfig(t.db, { autoReview: true });
    task('T1', { assignee: 'alpha' });
    await go(o);
    o.tick();
    await o.idle();
    expect(getTask(t.db, 'T1')?.status).toBe('done');
    const approved = getActivityFeed(t.db, { targetId: 'T1', limit: 30 }).find(
      (l) => l.action === 'task_approved',
    );
    expect(approved?.agent_id).toBe('beta');
    const runs = listRuns(t.db);
    expect(runs.map((r) => `${r.kind}:${r.agent_id}`).sort()).toEqual([
      'review:beta',
      'work:alpha',
    ]);
    expect(reviewer.calls[0]?.prompt).toContain('reported');
    expect(reviewer.calls[0]?.allowEdits).toBe(false);
  });

  it('a reject verdict sends the task back with the reason; no verdict leaves it in Review for the operator', async () => {
    const o = orchestrator({
      'claude-code': fake('claude-code', (i) =>
        Promise.resolve(
          i.system?.includes('independent reviewer')
            ? ok('hm\nVERDICT: REJECT\nREASON: no tests')
            : ok(),
        ),
      ),
    });
    setOrchestratorConfig(t.db, { autoReview: true });
    task('T1', { assignee: 'alpha' });
    await go(o);
    o.tick();
    await o.idle();
    expect(getTask(t.db, 'T1')?.status).toBe('in_progress');
    expect(
      getActivityFeed(t.db, { targetId: 'T1', limit: 30 }).some(
        (l) => l.action === 'task_rejected' && l.description?.includes('no tests'),
      ),
    ).toBe(true);

    const o2 = orchestrator({
      'claude-code': fake('claude-code', (i) =>
        Promise.resolve(i.system?.includes('independent reviewer') ? ok('unsure') : ok()),
      ),
    });
    task('T2', { assignee: 'alpha' });
    await go(o2);
    o2.tick();
    await o2.idle();
    expect(getTask(t.db, 'T2')?.status).toBe('review');
    expect(
      getActivityFeed(t.db, { targetId: 'T2', limit: 30 }).some(
        (l) => l.action === 'review_inconclusive',
      ),
    ).toBe(true);
  });

  it('an agent can never approve its own work, whatever calls the API', () => {
    task('T1', { assignee: 'alpha', status: 'in_progress' });
    transition(t.db, 'T1', 'complete', { actor: 'alpha', summary: 'done' });
    expect(() => transition(t.db, 'T1', 'approve', { actor: 'alpha' })).toThrow(/cannot approve/i);
    expect(() => transition(t.db, 'T1', 'approve', { actor: 'beta' })).not.toThrow();
  });

  it('with no other agent available the task waits in Review for the operator', async () => {
    const o = orchestrator({ 'claude-code': fake('claude-code') });
    setOrchestratorConfig(t.db, { autoReview: true });
    t.db.prepare("UPDATE agents SET executor = 'external' WHERE id IN ('beta','gamma')").run();
    task('T1', { assignee: 'alpha' });
    await go(o);
    o.tick();
    await o.idle();
    expect(getTask(t.db, 'T1')?.status).toBe('review');
    expect(listRuns(t.db)).toHaveLength(1);
  });
});

describe('keys never leak (D25)', () => {
  it('a provider error that echoes the key is redacted before it reaches the runs table, the log or the task', async () => {
    const KEY = 'sk-test-SECRET-0123456789';
    const o = orchestrator(
      {
        'anthropic-api': fake('anthropic-api', () =>
          Promise.reject(new ProviderError('failed', `HTTP 401: invalid x-api-key ${KEY}`, 401)),
        ),
      },
      { getKey: (id) => (id === 'anthropic-api' ? KEY : null) },
    );
    setAgentProvider(t.db, 'alpha', 'anthropic-api');
    task('T1');
    await go(o);
    o.tick();
    await o.idle();
    const dump = JSON.stringify({
      runs: t.db.prepare('SELECT * FROM runs').all(),
      log: t.db.prepare('SELECT * FROM agent_log').all(),
      tasks: t.db.prepare('SELECT * FROM subtasks').all(),
      settings: t.db.prepare('SELECT * FROM settings').all(),
    });
    expect(dump).not.toContain(KEY);
    expect(dump).toContain('invalid x-api-key ***');
    expect(getTask(t.db, 'T1')?.blocked_reason).toContain('***');
  });
});

describe('status and settings', () => {
  it('reports mode, counts and caps; config is validated and logged', async () => {
    const o = orchestrator({ 'claude-code': fake('claude-code') });
    await o.refreshProviders();
    expect(orchestratorStatus(t.db)).toMatchObject({
      mode: 'off',
      running: 0,
      queued: 0,
      maxConcurrent: 2,
      maxPerHour: 20,
      dailyCeiling: 5,
    });
    expect(getOrchestratorConfig(t.db)).toEqual({
      maxConcurrent: 2,
      maxPerHour: 20,
      dailySpendUsd: 5,
      runTimeoutMin: 15,
      autoReview: false,
    });
    expect(setOrchestratorConfig(t.db, { maxConcurrent: 3, autoReview: true })).toMatchObject({
      maxConcurrent: 3,
      autoReview: true,
    });
    expect(() => setOrchestratorConfig(t.db, { maxConcurrent: 0 })).toThrow();
    expect(() => setOrchestratorConfig(t.db, { nope: 1 })).toThrow();
    expect(
      getActivityFeed(t.db, { limit: 5 }).some((l) => l.action === 'orchestrator_config_changed'),
    ).toBe(true);
  });

  it('parses summaries and verdicts', () => {
    expect(extractSummary('a\nb\nSUMMARY: did x\n')).toBe('did x');
    expect(extractSummary('only text')).toBe('only text');
    expect(extractSummary('')).toBe('No output.');
    expect(parseVerdict('x\nVERDICT: approve\nREASON: ok')).toEqual({
      verdict: 'APPROVE',
      reason: 'ok',
    });
    expect(parseVerdict('nothing')).toEqual({ verdict: null, reason: '' });
  });
});
