import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import { InvalidInputError } from '../src/errors';
import { setAgentModel } from '../src/models';
import { Orchestrator, readyTasks, routeTask } from '../src/orchestrator';
import { setOrchestratorMode } from '../src/orchestrator-settings';
import {
  assignLibraryAgent,
  listAssignments,
  removeLibraryAgent,
  syncMirrors,
  updateAssignment,
} from '../src/project-agents';
import { buildRunPrompt } from '../src/prompt';
import {
  buildProviders,
  PROVIDER_IDS,
  type ProviderAdapter,
  type ProviderId,
  type ProviderRunInput,
} from '../src/providers';
import {
  createLibraryAgent,
  setLibraryAgentStatus,
  updateLibraryAgent,
} from '../src/library/agents';
import { addLesson } from '../src/lessons';
import { getAgent, getTask, listRuns } from '../src/queries';
import { tmpEnv, addTask, type Env } from './m15-helpers';

// M15 runtime: assignments, the D34 prompt, the live spec hash, the D36 missing / malformed project file, and a run record
// that says what it was built from.

let env: Env;
beforeEach(() => {
  env = tmpEnv();
});
afterEach(() => env.cleanup());

function fake(calls: ProviderRunInput[]): ProviderAdapter {
  return {
    id: 'claude-code',
    label: 'fake',
    kind: 'api',
    needsKey: false,
    defaultModel: null,
    detect: () => Promise.resolve({ available: true, detail: 'fake' }),
    test: () => Promise.resolve({ ok: true, detail: 'ok' }),
    run: (input) => {
      calls.push(input);
      return Promise.resolve({
        output: 'Did it.\nSUMMARY: all done',
        truncated: false,
        exitCode: 0,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: null },
      });
    },
  };
}

function orchestratorFor(p: { root: string; db: Db }, calls: ProviderRunInput[]) {
  const real = buildProviders({
    fetch,
    baseUrl: () => undefined,
    findBinary: () => null,
    apiKey: () => null,
  });
  const providers = { ...real, 'claude-code': fake(calls) } as Record<ProviderId, ProviderAdapter>;
  for (const id of PROVIDER_IDS) providers[id] ??= real[id];
  return new Orchestrator({
    db: p.db,
    projectRoot: p.root,
    providers,
    getKey: () => null,
    library: env.lib,
  });
}
const start = async (o: Orchestrator, p: { db: Db }) => {
  await o.refreshProviders();
  setOrchestratorMode(p.db, 'running');
};

const writer = () =>
  createLibraryAgent(env.lib, {
    name: 'Copywriter',
    role: 'marketing',
    base_instructions: 'Write plainly. Never invent claims.',
  });

describe('assigning library agents to a project', () => {
  it('links the one library agent into several projects without copying it; one edit reaches both', () => {
    const a = env.project('one');
    const b = env.project('two');
    writer();
    assignLibraryAgent(a.db, env.lib, 'copywriter');
    assignLibraryAgent(b.db, env.lib, 'copywriter');
    expect(getAgent(a.db, 'copywriter')?.name).toBe('Copywriter');
    expect(getAgent(b.db, 'copywriter')?.name).toBe('Copywriter');
    updateLibraryAgent(env.lib, 'copywriter', { name: 'Senior copywriter', model: 'opus' });
    expect(syncMirrors(a.db, env.lib)).toBe(1);
    expect(syncMirrors(b.db, env.lib)).toBe(1);
    expect(getAgent(a.db, 'copywriter')).toMatchObject({
      name: 'Senior copywriter',
      model: 'opus',
    });
    expect(getAgent(b.db, 'copywriter')).toMatchObject({
      name: 'Senior copywriter',
      model: 'opus',
    });
    // Nothing else was written for the second pass: the mirrors are already current.
    expect(syncMirrors(a.db, env.lib)).toBe(0);
  });

  it('removing keeps the library agent and its history; adding back restores the project settings', () => {
    const p = env.project();
    writer();
    assignLibraryAgent(p.db, env.lib, 'copywriter');
    updateAssignment(p.db, 'copywriter', {
      enabled: false,
      allowed_task_types: ['general'],
      extra_constraints: ['No emoji'],
    });
    removeLibraryAgent(p.db, 'copywriter');
    expect(listAssignments(p.db)).toHaveLength(0);
    expect(
      env.lib.prepare("SELECT id FROM library_agents WHERE id = 'copywriter'").get(),
    ).toBeTruthy();
    const back = assignLibraryAgent(p.db, env.lib, 'copywriter');
    expect(back.restored).toBe(true);
    expect(back.note).toMatch(/settings it had before/);
    expect(back.assignment).toMatchObject({
      enabled: false,
      allowed_task_types: ['general'],
      extra_constraints: ['No emoji'],
    });
  });

  it('a first-time assignment gets defaults and says so; archived agents cannot be assigned', () => {
    const p = env.project();
    writer();
    const first = assignLibraryAgent(p.db, env.lib, 'copywriter');
    expect(first.restored).toBe(false);
    expect(first.note).toMatch(/default project settings/);
    expect(first.assignment).toMatchObject({
      enabled: true,
      allowed_task_types: [],
      extra_constraints: [],
    });
    createLibraryAgent(env.lib, { name: 'Old', role: 'general' });
    setLibraryAgentStatus(env.lib, 'old', 'archived');
    expect(() => assignLibraryAgent(p.db, env.lib, 'old')).toThrow(InvalidInputError);
  });

  it('a library agent takes its provider and model from the library, not from the project', () => {
    const p = env.project();
    writer();
    assignLibraryAgent(p.db, env.lib, 'copywriter');
    expect(() => setAgentModel(p.db, 'copywriter', 'opus')).toThrow(/agent library/);
  });

  it('dispatch honours enabled, removed, allowed task types and archived-in-library', () => {
    const p = env.project();
    writer();
    assignLibraryAgent(p.db, env.lib, 'copywriter');
    addTask(p.db, 'T1', { assignee: 'copywriter', domain: 'marketing' });
    const ready = () => readyTasks(p.db, null, env.lib).map((t) => t.id);
    expect(ready()).toEqual(['T1']);
    updateAssignment(p.db, 'copywriter', { enabled: false });
    expect(ready()).toEqual([]);
    expect(routeTask(p.db, getTask(p.db, 'T1') as never, env.lib)).toBeNull();
    updateAssignment(p.db, 'copywriter', { enabled: true, allowed_task_types: ['design'] });
    expect(ready()).toEqual([]);
    updateAssignment(p.db, 'copywriter', { allowed_task_types: ['marketing'] });
    expect(ready()).toEqual(['T1']);
    setLibraryAgentStatus(env.lib, 'copywriter', 'archived');
    expect(ready()).toEqual([]);
    setLibraryAgentStatus(env.lib, 'copywriter', 'active');
    removeLibraryAgent(p.db, 'copywriter');
    expect(ready()).toEqual([]);
  });

  it('agents the library does not manage dispatch as before', () => {
    const p = env.project();
    p.db
      .prepare(
        "INSERT INTO agents (id, name, type, status, created_at) VALUES ('legacy','Legacy','sub-agent','idle','2026-01-01T00:00:00Z')",
      )
      .run();
    addTask(p.db, 'T1', { assignee: 'legacy' });
    expect(readyTasks(p.db, null, env.lib).map((t) => t.id)).toEqual(['T1']);
  });
});

describe('the prompt (D34): profile, then the project spec, then lessons, then the task', () => {
  const build = (p: { root: string; db: Db }, taskId = 'T1') =>
    buildRunPrompt({
      db: p.db,
      lib: env.lib,
      projectRoot: p.root,
      task: getTask(p.db, taskId) as never,
      agent: { id: 'copywriter', name: 'Copywriter' },
    });

  it('layers the agent profile before the project rules, and records which layers were used', () => {
    const p = env.project();
    writer();
    assignLibraryAgent(p.db, env.lib, 'copywriter');
    addTask(p.db, 'T1', { assignee: 'copywriter' });
    const b = build(p);
    expect(b.layers).toEqual(['profile', 'project_spec', 'task_context']);
    expect(b.system.indexOf('Write plainly')).toBeGreaterThan(-1);
    expect(b.system.indexOf('Write plainly')).toBeLessThan(b.system.indexOf('Project rules'));
    expect(b.system).toMatch(/override where they conflict/);
    expect(b.specStatus).toBe('ok');
    expect(b.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.lessonIds).toEqual([]); // the lookup ran and nothing matched
  });

  it('adds the "Before you start" block with the matched lesson ids between the spec and the task', () => {
    const p = env.project();
    writer();
    addTask(p.db, 'T1', { assignee: 'copywriter', label: 'Write the landing page headline' });
    addLesson(
      p.db,
      'T1',
      'Headline used the word revolutionary',
      '',
      undefined,
      'Avoid hype words',
      {
        checkText: 'no-match **/*.md /revolutionary/i',
        checkType: 'automatic',
        triggerKeywords: 'headline landing',
      },
    );
    const b = build(p);
    expect(b.layers).toEqual(['profile', 'project_spec', 'lessons', 'task_context']);
    expect(b.system).toMatch(/Before you start/);
    expect(b.lessonIds).toHaveLength(1);
    expect(b.lessonIds[0]).toMatch(/^p:\d+$/);
  });

  it('puts the extra constraints of this project into the system text', () => {
    const p = env.project();
    writer();
    assignLibraryAgent(p.db, env.lib, 'copywriter');
    updateAssignment(p.db, 'copywriter', { extra_constraints: ['Arabic first'] });
    addTask(p.db, 'T1', { assignee: 'copywriter' });
    expect(build(p).system).toMatch(/Extra constraints[\s\S]*Arabic first/);
  });

  it('a spec edit changes the hash on the very next build, with no restart', () => {
    const p = env.project();
    writer();
    addTask(p.db, 'T1', { assignee: 'copywriter' });
    const before = build(p).specHash;
    writeFileSync(join(p.root, 'AGENTS.md'), '# Spec\n\nChanged one line.\n');
    const after = build(p);
    expect(after.specHash).not.toBe(before);
    expect(after.system).toMatch(/Changed one line/);
  });

  it('forbidden tools in the spec are returned for the provider and named in the prompt', () => {
    const p = env.project();
    writer();
    addTask(p.db, 'T1', { assignee: 'copywriter' });
    writeFileSync(
      join(p.root, 'AGENTS.md'),
      '# Spec\n\n## Forbidden tools\n- `Bash`\n- WebFetch\n',
    );
    const b = build(p);
    expect(b.forbiddenTools).toEqual(['Bash', 'WebFetch']);
    expect(b.system).toMatch(/forbids these tools: Bash, WebFetch/);
  });

  it('without a spec the prompt still builds and says so in the layers (D36)', () => {
    const p = env.project();
    writer();
    addTask(p.db, 'T1', { assignee: 'copywriter' });
    rmSync(join(p.root, 'AGENTS.md'));
    const b = build(p);
    expect(b.specStatus).toBe('missing');
    expect(b.specHash).toBeNull();
    expect(b.layers).toEqual(['profile', 'task_context']);
  });
});

describe('a run records what it was built from', () => {
  it('stores layers, spec hash and status, and the injected lesson ids; passes forbidden tools to the provider', async () => {
    const p = env.project();
    writer();
    assignLibraryAgent(p.db, env.lib, 'copywriter');
    writeFileSync(join(p.root, 'AGENTS.md'), '# Spec\n\n## Forbidden tools\n- Bash\n');
    addTask(p.db, 'T1', { assignee: 'copywriter' });
    const calls: ProviderRunInput[] = [];
    const o = orchestratorFor(p, calls);
    await start(o, p);
    expect(o.tick()).toHaveLength(1);
    await o.idle();
    const [run] = listRuns(p.db);
    expect(run?.layers).toEqual(['profile', 'project_spec', 'task_context']);
    expect(run?.spec_status).toBe('ok');
    expect(run?.spec_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run?.lesson_ids).toEqual([]);
    expect(calls[0]?.disallowedTools).toEqual(['Bash']);
    expect(calls[0]?.system).toMatch(/Write plainly/);
  });

  it('a one-line spec change between two runs shows up as a new hash; removing the spec still runs', async () => {
    const p = env.project();
    writer();
    assignLibraryAgent(p.db, env.lib, 'copywriter');
    addTask(p.db, 'T1', { assignee: 'copywriter' });
    addTask(p.db, 'T2', { assignee: 'copywriter' });
    const calls: ProviderRunInput[] = [];
    const o = orchestratorFor(p, calls);
    await start(o, p);
    o.tick();
    await o.idle();
    writeFileSync(join(p.root, 'AGENTS.md'), '# Spec\n\nOne line changed.\n');
    o.tick();
    await o.idle();
    rmSync(join(p.root, 'AGENTS.md'));
    addTask(p.db, 'T3', { assignee: 'copywriter' });
    o.tick();
    await o.idle();
    const runs = listRuns(p.db).sort((a, b) => a.task_id.localeCompare(b.task_id));
    const hashes = runs.map((r) => r.spec_hash);
    expect(hashes[0]).not.toBeNull();
    expect(hashes[1]).not.toBeNull();
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(runs[2]).toMatchObject({ spec_status: 'missing', spec_hash: null, status: 'succeeded' });
  });

  it('a malformed project.json blocks dispatch for that project only, and names the bad field', async () => {
    const bad = env.project('bad');
    const good = env.project('good');
    writer();
    assignLibraryAgent(bad.db, env.lib, 'copywriter');
    assignLibraryAgent(good.db, env.lib, 'copywriter');
    addTask(bad.db, 'T1', { assignee: 'copywriter' });
    addTask(good.db, 'T1', { assignee: 'copywriter' });
    writeFileSync(
      join(bad.root, 'project.json'),
      JSON.stringify({ name: 'Bad', slug: 'Not A Slug' }),
    );
    const badCalls: ProviderRunInput[] = [];
    const goodCalls: ProviderRunInput[] = [];
    const ob = orchestratorFor(bad, badCalls);
    const og = orchestratorFor(good, goodCalls);
    await start(ob, bad);
    await start(og, good);
    expect(ob.tick()).toEqual([]);
    expect(ob.status().projectBlock).toMatch(/slug/);
    expect(og.tick()).toHaveLength(1);
    await og.idle();
    expect(badCalls).toHaveLength(0);
    expect(goodCalls).toHaveLength(1);
    expect(getTask(bad.db, 'T1')?.status).toBe('todo');
    expect(listRuns(bad.db)).toHaveLength(0);
  });
});
