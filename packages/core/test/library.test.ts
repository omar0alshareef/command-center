import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_TEMPLATES,
  createLibraryAgent,
  deleteOrArchiveLibraryAgent,
  fromTemplate,
  getLibraryAgent,
  listAgentVersions,
  listLibraryAgents,
  setLibraryAgentStatus,
  updateLibraryAgent,
} from '../src/library/agents';
import { openLibrary } from '../src/library/db';
import {
  agentUsage,
  getProjectByPath,
  listProjects,
  normalizePath,
  projectHealth,
  registerProject,
  removeProjectRecord,
} from '../src/library/registry';
import { assignLibraryAgent, removeLibraryAgent } from '../src/project-agents';
import {
  applyScaffold,
  lineDiff,
  parseSpecRules,
  planScaffold,
  readProjectFile,
  readSpec,
  slugify,
} from '../src/project-file';
import { DEMO, tmpEnv, type Env } from './m15-helpers';

let env: Env;
beforeEach(() => {
  env = tmpEnv();
});
afterEach(() => env.cleanup());

describe('library agents (D30)', () => {
  it('creates an agent with a slug id, writes version 1, and keeps an append-only history of edits', () => {
    const a = createLibraryAgent(env.lib, {
      name: 'Frontend Dev',
      role: 'frontend',
      base_instructions: 'Build UI.',
    });
    expect(a).toMatchObject({
      id: 'frontend-dev',
      role: 'frontend',
      status: 'active',
      executor: 'agent',
      provider: null,
    });
    expect(createLibraryAgent(env.lib, { name: 'Frontend Dev' }).id).toBe('frontend-dev-2');
    const b = updateLibraryAgent(env.lib, a.id, {
      base_instructions: 'Build accessible UI.',
      model: 'opus',
    });
    expect(b.base_instructions).toBe('Build accessible UI.');
    const versions = listAgentVersions(env.lib, a.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[1]?.snapshot.base_instructions).toBe('Build UI.');
    expect(() =>
      env.lib.prepare("UPDATE library_agent_versions SET note = 'x' WHERE version = 1").run(),
    ).toThrow(/append-only/);
  });

  it('validates: external needs a tool, reserved ids, parent cycles, unknown providers', () => {
    expect(() => createLibraryAgent(env.lib, { name: 'Voice', executor: 'external' })).toThrow(
      /needs the name of that tool/,
    );
    expect(
      createLibraryAgent(env.lib, { name: 'Voice', executor: 'external', tool: 'Voice tool' }).tool,
    ).toBe('Voice tool');
    expect(() => createLibraryAgent(env.lib, { name: 'X', id: 'operator' })).toThrow(/reserved/);
    expect(() => createLibraryAgent(env.lib, { name: 'X', provider: 'telepathy' })).toThrow();
    const root = createLibraryAgent(env.lib, { name: 'Lead' });
    const kid = createLibraryAgent(env.lib, { name: 'Kid', parent_id: root.id });
    expect(() => updateLibraryAgent(env.lib, root.id, { parent_id: kid.id })).toThrow(/ancestor/);
    expect(() => updateLibraryAgent(env.lib, 'ghost', { name: 'x' })).toThrow(/does not exist/);
  });

  it('lists sorted by role then name, filters by role, status, provider and search', () => {
    createLibraryAgent(env.lib, { name: 'Zed', role: 'backend' });
    createLibraryAgent(env.lib, { name: 'Amy', role: 'backend', provider: 'local' });
    createLibraryAgent(env.lib, {
      name: 'Bob',
      role: 'design',
      base_instructions: 'Use tokens only.',
    });
    const c = createLibraryAgent(env.lib, { name: 'Old', role: 'design' });
    setLibraryAgentStatus(env.lib, c.id, 'archived');
    expect(listLibraryAgents(env.lib).map((a) => a.name)).toEqual(['Amy', 'Zed', 'Bob']);
    expect(listLibraryAgents(env.lib, { role: 'design' }).map((a) => a.name)).toEqual(['Bob']);
    expect(listLibraryAgents(env.lib, { status: 'archived' }).map((a) => a.name)).toEqual(['Old']);
    expect(listLibraryAgents(env.lib, { status: 'all' })).toHaveLength(4);
    expect(listLibraryAgents(env.lib, { provider: 'local' }).map((a) => a.name)).toEqual(['Amy']);
    expect(listLibraryAgents(env.lib, { provider: 'claude-code' }).map((a) => a.name)).toEqual([
      'Zed',
      'Bob',
    ]);
    expect(listLibraryAgents(env.lib, { search: 'tokens' }).map((a) => a.name)).toEqual(['Bob']);
  });

  it('offers starter templates for the seven roles, editable like any agent', () => {
    expect(AGENT_TEMPLATES.map((t) => t.role)).toEqual([
      'frontend',
      'backend',
      'database',
      'security',
      'design',
      'marketing',
      'reviewer',
    ]);
    const draft = fromTemplate('reviewer');
    expect(draft?.base_instructions).toMatch(/independently/);
    const a = createLibraryAgent(env.lib, { ...draft, name: 'My reviewer' });
    expect(
      updateLibraryAgent(env.lib, a.id, { base_instructions: 'Mine.' }).base_instructions,
    ).toBe('Mine.');
    expect(fromTemplate('nope')).toBeNull();
  });
});

describe('project registry and health', () => {
  it('registers a folder once (path-normalised), lists it, and removing it never deletes files', () => {
    const p = env.project('alpha');
    const rec = registerProject(env.lib, { name: 'Alpha', path: p.root, opened: true });
    expect(registerProject(env.lib, { name: 'Alpha renamed', path: `${p.root}\\.\\` }).id).toBe(
      rec.id,
    );
    expect(listProjects(env.lib)).toHaveLength(1);
    expect(listProjects(env.lib)[0]?.name).toBe('Alpha renamed');
    expect(getProjectByPath(env.lib, p.root)?.id).toBe(rec.id);
    removeProjectRecord(env.lib, rec.id);
    expect(listProjects(env.lib)).toEqual([]);
    expect(existsSync(join(p.root, 'AGENTS.md'))).toBe(true);
    expect(() => removeProjectRecord(env.lib, rec.id)).toThrow(/not registered/);
  });

  it('the registry survives reopening the library file', () => {
    const p = env.project('persist');
    registerProject(env.lib, { name: 'Persist', path: p.root });
    const again = openLibrary(env.libDir);
    try {
      expect(listProjects(again).map((x) => normalizePath(x.path))).toEqual([
        normalizePath(p.root),
      ]);
    } finally {
      again.close();
    }
  });

  it('health: a missing folder cannot be opened; a malformed project.json can, but blocks dispatch and names the field', () => {
    expect(projectHealth(join(env.libDir, 'nowhere'))).toMatchObject({
      openable: false,
      error: expect.stringContaining('does not exist'),
    });
    const p = env.project('broken');
    expect(projectHealth(p.root)).toMatchObject({
      openable: true,
      error: null,
      dispatchBlock: null,
    });
    const file = join(p.root, 'project.json');
    const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...j, status: 'finished', slug: 'Bad Slug' }));
    const h = projectHealth(p.root);
    expect(h.openable).toBe(true);
    expect(h.dispatchBlock).toMatch(/project\.json: status/);
    expect(h.dispatchBlock).toMatch(/project\.json: slug/);
    writeFileSync(file, '{ not json');
    expect(projectHealth(p.root).dispatchBlock).toMatch(/not valid JSON/);
    const r = readProjectFile(p.root);
    expect(r.ok).toBe(false);
  });

  it('a bare folder (no project.json) is a legacy project: openable, not blocked', () => {
    const b = env.bare('legacy');
    const h = projectHealth(b.root);
    expect(h).toMatchObject({ openable: true, dispatchBlock: null });
    expect(h.projectFile?.ok).toBe(false);
  });
});

describe('project files: scaffold, spec, rules', () => {
  it('plans and writes the missing files from templates and never overwrites an existing one', () => {
    const b = env.bare('fresh');
    const plan = planScaffold(b.root, { name: 'Fresh Project', today: '2026-10-13' });
    expect(plan.map((i) => `${i.path}:${i.action}`)).toEqual(
      [
        'project.json:create',
        'README.md:create',
        'AGENTS.md:create',
        'details\\README.md:create',
      ].map((s) => s.replace('\\', process.platform === 'win32' ? '\\' : '/')),
    );
    const done = applyScaffold(b.root, plan);
    expect(done.written).toHaveLength(4);
    const r = readProjectFile(b.root);
    expect(r.ok && r.project).toMatchObject({
      name: 'Fresh Project',
      slug: 'fresh-project',
      status: 'active',
      created: '2026-10-13',
    });
    // second pass: all identical
    expect(
      planScaffold(b.root, { name: 'Fresh Project', today: '2026-10-13' }).every(
        (i) => i.action === 'same',
      ),
    ).toBe(true);
    // an edited AGENTS.md is a collision: shown as a diff, kept unless the operator says replace
    writeFileSync(join(b.root, 'AGENTS.md'), '# my own rules\n');
    const again = planScaffold(b.root, { name: 'Fresh Project', today: '2026-10-13' });
    const agents = again.find((i) => i.path === 'AGENTS.md');
    expect(agents).toMatchObject({ action: 'differs', current: '# my own rules\n' });
    expect(applyScaffold(b.root, again).kept).toContain('AGENTS.md');
    expect(readFileSync(join(b.root, 'AGENTS.md'), 'utf8')).toBe('# my own rules\n');
    applyScaffold(b.root, again, { replace: ['AGENTS.md'] });
    expect(readFileSync(join(b.root, 'AGENTS.md'), 'utf8')).toContain(
      'Project Spec: Fresh Project',
    );
  });

  it('copies LICENSE from the repo (never writes its own text) and never overwrites an existing one', () => {
    const b = env.bare('licensed');
    const repo = env.bare('repo');
    writeFileSync(join(repo.root, 'LICENSE'), 'MIT License\nCopyright 2026\n');
    const plan = planScaffold(b.root, { name: 'Licensed', repoPath: repo.root });
    expect(plan.find((i) => i.kind === 'license-copy')?.action).toBe('create');
    applyScaffold(b.root, plan, { repoPath: repo.root });
    expect(readFileSync(join(b.root, 'LICENSE'), 'utf8')).toBe('MIT License\nCopyright 2026\n');
    writeFileSync(join(b.root, 'LICENSE'), 'MY OWN LICENSE');
    expect(
      planScaffold(b.root, { name: 'Licensed', repoPath: repo.root }).find(
        (i) => i.kind === 'license-copy',
      )?.action,
    ).toBe('same');
    applyScaffold(b.root, planScaffold(b.root, { name: 'Licensed', repoPath: repo.root }), {
      repoPath: repo.root,
    });
    expect(readFileSync(join(b.root, 'LICENSE'), 'utf8')).toBe('MY OWN LICENSE');
    expect(
      planScaffold(env.bare('nolic').root, { name: 'No license' }).some(
        (i) => i.kind === 'license-copy',
      ),
    ).toBe(false);
  });

  it('reads the spec with a content hash that changes on the next edit; missing and unreadable are reported', () => {
    const p = env.project('spec');
    const a = readSpec(p.root, null);
    expect(a.status).toBe('ok');
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    const text = readFileSync(join(p.root, 'AGENTS.md'), 'utf8');
    writeFileSync(join(p.root, 'AGENTS.md'), text.replace('Inter for text', 'Inter for body text'));
    const b = readSpec(p.root, null);
    expect(b.hash).not.toBe(a.hash);
    expect(b.text).toContain('Inter for body text');
    rmSyncSafe(join(p.root, 'AGENTS.md'));
    expect(readSpec(p.root, null)).toMatchObject({ status: 'missing', text: null, hash: null });
  });

  it('parses forbidden tools from the spec and a line diff for the collision dialog', () => {
    expect(
      parseSpecRules(
        '# x\n## Forbidden tools\n- `Bash`\n- WebFetch: no network\n* Edit\n## Other\n- `NotThis`\n',
      ).forbiddenTools,
    ).toEqual(['Bash', 'WebFetch', 'Edit']);
    expect(parseSpecRules('## forbidden TOOLS\n<!-- none -->\n').forbiddenTools).toEqual([]);
    expect(parseSpecRules('nothing here').forbiddenTools).toEqual([]);
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toBe('  a\n- b\n+ x\n  c');
    expect(slugify('  My Great_Project! ')).toBe('my-great-project');
  });
});

import { rmSync } from 'node:fs';
const rmSyncSafe = (p: string) => rmSync(p, { force: true });

describe('delete or archive (D35)', () => {
  const register = (name: string, root: string) => registerProject(env.lib, { name, path: root });

  it('an agent with no links and no runs is deleted; versions go with it', () => {
    const a = createLibraryAgent(env.lib, { name: 'Unused' });
    const usage = agentUsage(env.lib, a.id);
    expect(usage).toEqual({ links: 0, runs: 0, projects: [] });
    expect(deleteOrArchiveLibraryAgent(env.lib, a.id, usage)).toEqual({
      result: 'deleted',
      agent: null,
    });
    expect(getLibraryAgent(env.lib, a.id)).toBeNull();
    expect(listAgentVersions(env.lib, a.id)).toEqual([]);
  });

  it('an agent linked to a project is archived, stays readable, and drops out of the default list', () => {
    const a = createLibraryAgent(env.lib, { name: 'Linked' });
    const p = env.project('p1');
    register('P1', p.root);
    assignLibraryAgent(p.db, env.lib, a.id);
    const usage = agentUsage(env.lib, a.id);
    expect(usage).toMatchObject({ links: 1, runs: 0, projects: ['P1'] });
    const r = deleteOrArchiveLibraryAgent(env.lib, a.id, usage);
    expect(r.result).toBe('archived');
    expect(getLibraryAgent(env.lib, a.id)?.status).toBe('archived');
    expect(listLibraryAgents(env.lib)).toEqual([]);
    expect(setLibraryAgentStatus(env.lib, a.id, 'active').status).toBe('active');
  });

  it('after unlinking it can be deleted, unless it has run history, then it is archived', () => {
    const a = createLibraryAgent(env.lib, { name: 'Veteran' });
    const p = env.project('p2');
    register('P2', p.root);
    assignLibraryAgent(p.db, env.lib, a.id);
    removeLibraryAgent(p.db, a.id);
    expect(agentUsage(env.lib, a.id).links).toBe(0);
    // run history in the project (a task and a run by this agent)
    p.db.prepare("INSERT INTO milestones (id, title) VALUES ('M1', 'm')").run();
    p.db.prepare("INSERT INTO subtasks (id, milestone_id, label) VALUES ('T1', 'M1', 't')").run();
    p.db
      .prepare(
        "INSERT INTO runs (id, task_id, agent_id, provider, status, queued_at) VALUES ('r1', 'T1', ?, 'local', 'succeeded', '2026-01-01T00:00:00Z')",
      )
      .run(a.id);
    const usage = agentUsage(env.lib, a.id);
    expect(usage).toMatchObject({ links: 0, runs: 1 });
    expect(deleteOrArchiveLibraryAgent(env.lib, a.id, usage).result).toBe('archived');
  });

  it('a project that cannot be read counts as a link, so nothing is deleted by mistake', () => {
    const a = createLibraryAgent(env.lib, { name: 'Careful' });
    const p = env.project('p3');
    register('P3', p.root);
    p.db.close();
    writeFileSync(join(p.root, 'command-center.db'), 'this is not a database');
    expect(agentUsage(env.lib, a.id)).toMatchObject({ links: 1, projects: ['P3 (unreadable)'] });
  });
});

describe('demo project fixture', () => {
  it('is a valid project with a spec', () => {
    const r = readProjectFile(DEMO);
    expect(r.ok && r.project.slug).toBe('demo-project');
    expect(readSpec(DEMO, null).status).toBe('ok');
  });
});
