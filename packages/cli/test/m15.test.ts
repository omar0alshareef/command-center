import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addLesson,
  assignLibraryAgent,
  createLibraryAgent,
  openDb,
  openLibrary,
  recordRecurrence,
  registerProject,
  type Db,
  type LibraryDb,
} from '@command-center/core';
import {
  lessonsCommand,
  libraryAgentsCommand,
  projectsCommand,
  projectStatusCommand,
} from '../src/commands';

// The M15 operator commands read the app-wide library and the project's spec, lessons and assignments.

const DEMO = resolve(__dirname, '../../../sample-projects/demo-project');
let base: string;
let root: string;
let db: Db;
let lib: LibraryDb;
let saved: string | undefined;
const lines: string[] = [];
const out = (l: string) => lines.push(l);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cc-cli-m15-'));
  root = join(base, 'demo');
  cpSync(DEMO, root, { recursive: true });
  db = openDb(root);
  lib = openLibrary(join(base, 'appdata'));
  saved = process.env['COMMAND_CENTER_LIBRARY'];
  process.env['COMMAND_CENTER_LIBRARY'] = join(base, 'appdata');
  lines.length = 0;
  db.prepare(
    "INSERT INTO milestones (id, title, planned_start) VALUES ('M1','First','2026-01-05')",
  ).run();
  db.prepare(
    "INSERT INTO subtasks (id, milestone_id, label) VALUES ('T1','M1','Write copy')",
  ).run();
});
afterEach(() => {
  db.close();
  lib.close();
  if (saved === undefined) delete process.env['COMMAND_CENTER_LIBRARY'];
  else process.env['COMMAND_CENTER_LIBRARY'] = saved;
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

describe('project status', () => {
  it('reports the spec, assigned agents and lesson counts', () => {
    createLibraryAgent(lib, { name: 'Copywriter', role: 'marketing' });
    assignLibraryAgent(db, lib, 'copywriter');
    addLesson(db, 'T1', 'Used hype words');
    projectStatusCommand({ root, db }, false, out);
    const text = lines.join('\n');
    expect(text).toMatch(/Demo Project/);
    expect(text).toMatch(/Project spec: .*AGENTS\.md/);
    expect(text).toMatch(/Agents: Copywriter/);
    expect(text).toMatch(/1 in this project \(0 active, 1 draft, 0 need a rewrite\)/);
  });

  it('says when the spec is missing and still works as JSON', () => {
    rmSync(join(root, 'AGENTS.md'));
    projectStatusCommand({ root, db }, true, out);
    const j = JSON.parse(lines.join('\n')) as { spec: { status: string }; agents: unknown[] };
    expect(j.spec.status).toBe('missing');
    expect(j.agents).toEqual([]);
  });
});

describe('projects and the library', () => {
  it('lists registered projects and why one cannot be opened', () => {
    registerProject(lib, { name: 'Demo', path: root });
    registerProject(lib, { name: 'Gone', path: join(base, 'missing-folder') });
    projectsCommand(false, out);
    const text = lines.join('\n');
    expect(text).toMatch(/Demo\s+.*ok/);
    expect(text).toMatch(/Gone[\s\S]*does not exist/);
  });

  it('lists library agents, and explains an absent library', () => {
    createLibraryAgent(lib, { name: 'Reviewer', role: 'reviewer' });
    libraryAgentsCommand(false, out);
    expect(lines.join('\n')).toMatch(/reviewer\s+reviewer/);
    lib.close();
    rmSync(join(base, 'appdata'), { recursive: true, force: true });
    lines.length = 0;
    libraryAgentsCommand(false, out);
    expect(lines.join('\n')).toMatch(/No agent library yet/);
    lib = openLibrary(join(base, 'appdata')); // so afterEach can close it
  });
});

describe('lessons --needs-rewrite', () => {
  it('lists only lessons whose mistake came back', () => {
    const a = addLesson(db, 'T1', 'Hype words', '', undefined, '', {
      checkText: 'Read the style guide',
      checkType: 'manual',
    });
    addLesson(db, 'T1', 'Other thing', '', undefined, '', { checkText: 'x', checkType: 'manual' });
    recordRecurrence(db, a);
    recordRecurrence(db, a);
    lessonsCommand({ root, db }, { limit: 10, json: false, needsRewrite: true }, out);
    expect(lines.join('\n')).toMatch(/project #\d+\s+2x\s+Hype words/);
    expect(lines.join('\n')).not.toMatch(/Other thing/);
  });
});
