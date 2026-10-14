import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditCompletedTask, runLessonChecks } from '../src/lesson-audit';
import { CHECK_SYNTAX, globFiles, parseCheck, runCheck, validateCheck } from '../src/lesson-checks';
import {
  addLesson,
  getLesson,
  recordRecurrence,
  syncLessonsFile,
  updateLesson,
} from '../src/lessons';
import {
  formatLessonsBlock,
  getRequiredLessons,
  NEEDS_CHECK,
  promoteLesson,
  retireLesson,
} from '../src/lessons-scope';
import { createLibraryAgent } from '../src/library/agents';
import {
  addLibraryLesson,
  getLibraryLesson,
  listLibraryLessons,
  recordLibraryRecurrence,
  updateLibraryLesson,
} from '../src/library/lessons';
import { getActivityFeed, getTask } from '../src/queries';
import { transition } from '../src/state-machine';
import { addTask, tmpEnv, type Env } from './m15-helpers';

let env: Env;
beforeEach(() => {
  env = tmpEnv();
});
afterEach(() => env.cleanup());

/** Reject a review task as the operator, with the lesson fields a reviewer can give. */
function reject(
  db: ReturnType<Env['project']>['db'],
  id: string,
  reason: string,
  extra: Record<string, unknown> = {},
) {
  db.prepare("UPDATE subtasks SET status = 'review' WHERE id = ?").run(id);
  transition(db, id, 'reject', { reason, ...extra });
}
const lastLessonId = (db: ReturnType<Env['project']>['db']) =>
  (db.prepare('SELECT MAX(id) AS n FROM lessons_learned').get() as { n: number }).n;

describe('the rejection flow (D40)', () => {
  it('a rejection with no prevention check is a project-scope DRAFT; with one it is ACTIVE', () => {
    const { db } = env.project();
    addTask(db, 'T1', { label: 'Landing page copy' });
    reject(db, 'T1', 'Used an exclamation mark in a product description');
    const draft = getLesson(db, lastLessonId(db));
    expect(draft).toMatchObject({
      scope: 'project',
      status: 'draft',
      check_type: 'none',
      check_text: '',
      occurrences: 0,
    });
    reject(db, 'T1', 'Used emoji', {
      check: 'no-match **/*.md /[\\u{1F300}-\\u{1FAFF}]/u',
      checkType: 'manual',
    });
    expect(getLesson(db, lastLessonId(db))).toMatchObject({
      status: 'active',
      check_type: 'manual',
    });
  });

  it('an automatic check must be valid syntax; the error lists the accepted forms', () => {
    const { db } = env.project();
    addTask(db, 'T1');
    db.prepare("UPDATE subtasks SET status = 'review' WHERE id = 'T1'").run();
    expect(() =>
      transition(db, 'T1', 'reject', { reason: 'x', check: 'rm -rf /', checkType: 'automatic' }),
    ).toThrow(/Automatic check not understood/);
    expect(getTask(db, 'T1')?.status).toBe('review'); // nothing happened
    expect(() => validateCheck('rm -rf /')).toThrow(
      new RegExp(CHECK_SYNTAX.split('|')[0]?.trim() as string),
    );
    expect(() => validateCheck('file-exists ../secrets')).toThrow(/inside the project folder/);
    expect(() => validateCheck('file-exists C:\\Windows')).toThrow(/inside the project folder/);
    expect(() => validateCheck('no-match **/*.ts /(/')).toThrow(/regular expression/);
    expect(() => validateCheck('command rm -rf x')).toThrow(/not understood/);
    expect(() => validateCheck('command npm run lint')).not.toThrow();
  });

  it('LESSONS_LEARNED.md is still generated from the table for the project (M10)', () => {
    const { db, root } = env.project();
    addTask(db, 'T1');
    reject(db, 'T1', 'Forgot the empty state', { prevention: 'Always design the empty state' });
    expect(readFileSync(join(root, '.claude', 'LESSONS_LEARNED.md'), 'utf8')).toContain(
      'Forgot the empty state',
    );
    expect(syncLessonsFile(db)).toContain('LESSONS_LEARNED.md');
  });

  it('a draft that is given a check becomes active; edits are validated; promoted rows are read-only', () => {
    const { db } = env.project();
    addTask(db, 'T1');
    reject(db, 'T1', 'Missing alt text');
    const id = lastLessonId(db);
    expect(
      updateLesson(db, id, { check_text: 'must-match **/*.html /alt=/', check_type: 'automatic' }),
    ).toMatchObject({ status: 'active', check_type: 'automatic' });
    expect(() => updateLesson(db, id, { check_text: 'bogus', check_type: 'automatic' })).toThrow(
      /not understood/,
    );
    expect(updateLesson(db, id, { check_text: '' })).toMatchObject({
      check_type: 'none',
      check_text: '',
    });
  });
});

describe('recurrence (D39)', () => {
  it('two recurrences after the lesson is active make it needs_rewrite, counted through the reject flow', () => {
    const { db } = env.project();
    addTask(db, 'T1', { label: 'Hero banner' });
    reject(db, 'T1', 'Banner used a second font', {
      check: 'must-match **/*.css /font-family: Inter/',
      checkType: 'manual',
    });
    const id = lastLessonId(db);
    reject(db, 'T1', 'Banner used a second font again', { sameAs: id });
    expect(getLesson(db, id)).toMatchObject({ occurrences: 1, status: 'active' });
    reject(db, 'T1', 'And again', { sameAs: id });
    expect(getLesson(db, id)).toMatchObject({ occurrences: 2, status: 'needs_rewrite' });
    expect((db.prepare('SELECT COUNT(*) n FROM lessons_learned').get() as { n: number }).n).toBe(1); // no duplicate lessons
    expect(getTask(db, 'T1')?.status).toBe('in_progress');
  });

  it('a draft that keeps recurring needs a rewrite too; a retired one stays retired; library lessons count the same way', () => {
    const { db } = env.project();
    addTask(db, 'T1');
    reject(db, 'T1', 'x');
    const id = lastLessonId(db);
    recordRecurrence(db, id);
    expect(recordRecurrence(db, id).status).toBe('needs_rewrite');
    reject(db, 'T1', 'y', { check: 'file-exists README.md', checkType: 'manual' });
    const id2 = lastLessonId(db);
    retireLesson(db, id2);
    expect(recordRecurrence(db, id2)).toMatchObject({ occurrences: 1, status: 'retired' });
    expect(() => recordRecurrence(db, 9999)).toThrow(/does not exist/);

    const a = createLibraryAgent(env.lib, { name: 'Writer' });
    const l = addLibraryLesson(env.lib, {
      scope: 'agent',
      agentId: a.id,
      rejectionReason: 'r',
      checkText: 'file-exists README.md',
      checkType: 'manual',
    });
    expect(recordLibraryRecurrence(env.lib, l.id)).toMatchObject({
      occurrences: 1,
      status: 'active',
    });
    expect(recordLibraryRecurrence(env.lib, l.id)).toMatchObject({
      occurrences: 2,
      status: 'needs_rewrite',
    });
  });
});

describe('scopes and promotion (D37, D40)', () => {
  it('a lesson with no prevention check cannot be promoted beyond project scope, and the message says why', () => {
    const { db } = env.project();
    const a = createLibraryAgent(env.lib, { name: 'Writer' });
    addTask(db, 'T1');
    reject(db, 'T1', 'no check given');
    const id = lastLessonId(db);
    expect(() => promoteLesson(db, env.lib, id, { scope: 'agent', agentId: a.id })).toThrow(
      NEEDS_CHECK,
    );
    expect(() => promoteLesson(db, env.lib, id, { scope: 'global' })).toThrow(
      /no prevention check/,
    );
    expect(listLibraryLessons(env.lib)).toEqual([]);
    expect(() => promoteLesson(db, env.lib, 9999, { scope: 'global' })).toThrow(/does not exist/);
  });

  it('promotion to agent scope reaches a SECOND project for the same library agent, and not for another agent', () => {
    const p1 = env.project('p1');
    const p2 = env.project('p2');
    const writer = createLibraryAgent(env.lib, { name: 'Writer' });
    const other = createLibraryAgent(env.lib, { name: 'Other' });
    addTask(p1.db, 'T1', { label: 'Write product descriptions' });
    reject(p1.db, 'T1', 'Descriptions made up a price', {
      prevention: 'Never state a price that is not in the brief',
      check: 'no-match **/*.md /\\$[0-9]+/',
      checkType: 'automatic',
    });
    const id = lastLessonId(p1.db);
    const made = promoteLesson(
      p1.db,
      env.lib,
      id,
      { scope: 'agent', agentId: writer.id },
      { projectId: 'p1' },
    );
    expect(made).toMatchObject({
      scope: 'agent',
      agent_id: writer.id,
      status: 'active',
      origin_task: 'T1',
    });
    expect(getLesson(p1.db, id)).toMatchObject({
      scope: 'agent',
      promoted_to: `agent:${writer.id}`,
    });
    expect(
      getActivityFeed(p1.db, { limit: 5 }).find((l) => l.action === 'lesson_promoted')?.description,
    ).toContain('promoted to agent Writer');

    addTask(p2.db, 'X1', { label: 'Write product descriptions for the shop' });
    const forWriter = getRequiredLessons(p2.db, env.lib, {
      agentId: writer.id,
      taskId: 'X1',
      label: 'Write product descriptions for the shop',
    });
    expect(forWriter.map((l) => `${l.source}:${l.scope}`)).toEqual(['library:agent']);
    expect(
      getRequiredLessons(p2.db, env.lib, {
        agentId: other.id,
        taskId: 'X1',
        label: 'Write product descriptions for the shop',
      }),
    ).toEqual([]);
    // the promoted project row no longer injects in its own project (the library copy applies)
    expect(
      getRequiredLessons(p1.db, null, {
        agentId: writer.id,
        taskId: 'T9',
        label: 'Write product descriptions',
      }),
    ).toEqual([]);
  });

  it('promotion to global applies to every agent, in every project', () => {
    const p1 = env.project('g1');
    const p2 = env.project('g2');
    const a = createLibraryAgent(env.lib, { name: 'A' });
    const b = createLibraryAgent(env.lib, { name: 'B' });
    addTask(p1.db, 'T1', { label: 'Update the landing page headline' });
    reject(p1.db, 'T1', 'Headline claimed a feature that does not exist', {
      check: 'must-match README.md /Goal/',
      checkType: 'manual',
    });
    promoteLesson(p1.db, env.lib, lastLessonId(p1.db), { scope: 'global' });
    addTask(p2.db, 'X1', { label: 'New landing page headline' });
    for (const who of [a, b]) {
      const got = getRequiredLessons(p2.db, env.lib, {
        agentId: who.id,
        taskId: 'X1',
        label: 'New landing page headline',
      });
      expect(got.map((l) => l.scope)).toEqual(['global']);
    }
    expect(() => promoteLesson(p1.db, env.lib, lastLessonId(p1.db), { scope: 'global' })).toThrow(
      /already promoted/,
    );
  });

  it('promotion needs an existing library agent for agent scope; retired lessons cannot be promoted', () => {
    const { db } = env.project();
    addTask(db, 'T1');
    reject(db, 'T1', 'r', { check: 'file-exists README.md', checkType: 'manual' });
    const id = lastLessonId(db);
    expect(() => promoteLesson(db, env.lib, id, { scope: 'agent', agentId: 'ghost' })).toThrow(
      /does not exist/,
    );
    retireLesson(db, id);
    expect(() => promoteLesson(db, env.lib, id, { scope: 'global' })).toThrow(/retired/);
    expect(() =>
      addLibraryLesson(env.lib, {
        scope: 'global',
        rejectionReason: 'r',
        checkText: '',
        checkType: 'manual',
      }),
    ).toThrow(/needs a prevention check/);
  });

  it('library lessons can be edited but keep a check; library lookups exclude retired ones', () => {
    const a = createLibraryAgent(env.lib, { name: 'A' });
    const l = addLibraryLesson(env.lib, {
      scope: 'agent',
      agentId: a.id,
      rejectionReason: 'bad tone',
      checkText: 'file-exists README.md',
      checkType: 'manual',
      triggerKeywords: 'tone voice',
    });
    expect(updateLibraryLesson(env.lib, l.id, { prevention: 'Use plain words' }).prevention).toBe(
      'Use plain words',
    );
    expect(() => updateLibraryLesson(env.lib, l.id, { check_text: '' })).toThrow(
      /keeps a prevention check/,
    );
    const { db } = env.project();
    expect(
      getRequiredLessons(db, env.lib, { agentId: a.id, label: 'Check the voice of the page' }).map(
        (x) => x.id,
      ),
    ).toEqual([l.id]);
    updateLibraryLesson(env.lib, l.id, { status: 'retired' });
    expect(
      getRequiredLessons(db, env.lib, { agentId: a.id, label: 'Check the voice of the page' }),
    ).toEqual([]);
    expect(getLibraryLesson(env.lib, l.id)?.status).toBe('retired');
  });
});

describe('required reading (D38)', () => {
  it('orders agent, then project, then global, newest first, and caps the list', () => {
    const { db } = env.project();
    const a = createLibraryAgent(env.lib, { name: 'A' });
    addTask(db, 'T1', { label: 'Design the pricing page' });
    const p = (reason: string, at: string) =>
      addLesson(db, 'T1', reason, '', at, 'prevent pricing mistakes');
    p('older pricing mistake', '2026-01-01T00:00:00.000Z');
    p('newer pricing mistake', '2026-02-01T00:00:00.000Z');
    addLibraryLesson(env.lib, {
      scope: 'global',
      rejectionReason: 'global pricing rule',
      checkText: 'file-exists README.md',
      checkType: 'manual',
    });
    addLibraryLesson(env.lib, {
      scope: 'agent',
      agentId: a.id,
      rejectionReason: 'agent pricing rule',
      checkText: 'file-exists README.md',
      checkType: 'manual',
    });
    const all = getRequiredLessons(db, env.lib, {
      agentId: a.id,
      label: 'Design the pricing page',
    });
    expect(all.map((l) => l.reason)).toEqual([
      'agent pricing rule',
      'newer pricing mistake',
      'older pricing mistake',
      'global pricing rule',
    ]);
    expect(
      getRequiredLessons(db, env.lib, {
        agentId: a.id,
        label: 'Design the pricing page',
        limit: 2,
      }),
    ).toHaveLength(2);
    expect(
      getRequiredLessons(db, env.lib, {
        agentId: a.id,
        label: 'Completely unrelated rocket science',
      }),
    ).toEqual([]);
  });

  it("the task's own earlier rejections always come first in the project group, even without matching words", () => {
    const { db } = env.project();
    addTask(db, 'T1', { label: 'Alpha' });
    addTask(db, 'T2', { label: 'Alpha beta' });
    addLesson(db, 'T2', 'other task, matches by word alpha', '', '2026-03-01T00:00:00.000Z', '');
    addLesson(
      db,
      'T1',
      'own rejection about something else entirely',
      '',
      '2026-01-01T00:00:00.000Z',
      '',
    );
    const got = getRequiredLessons(db, null, { agentId: null, taskId: 'T1', label: 'Alpha' });
    expect(got.map((l) => l.reason)).toEqual([
      'own rejection about something else entirely',
      'other task, matches by word alpha',
    ]);
  });

  it('formats a numbered "Before you start" block and nothing when empty', () => {
    expect(formatLessonsBlock([])).toBe('');
    const { db } = env.project();
    addTask(db, 'T1', { label: 'Tone of voice' });
    addLesson(db, 'T1', 'Too loud', 'Rewrote it', undefined, 'Keep it calm', {
      checkText: 'file-exists README.md',
      checkType: 'manual',
    });
    const block = formatLessonsBlock(
      getRequiredLessons(db, null, { agentId: null, taskId: 'T1', label: 'Tone of voice' }),
    );
    expect(block).toMatch(
      /^## Before you start\n.*\n1\. \[project\] Too loud Fix: Rewrote it Prevention: Keep it calm Check \(manual\): file-exists README\.md$/,
    );
  });

  it("trigger keywords make a lesson apply to tasks that do not share its reason's words", () => {
    const { db } = env.project();
    addTask(db, 'T1', { label: 'Something' });
    addLesson(db, 'T1', 'Wrong date format', '', undefined, '', {
      triggerKeywords: 'calendar schedule',
    });
    expect(
      getRequiredLessons(db, null, { agentId: null, label: 'Build the calendar widget' }),
    ).toHaveLength(1);
    expect(
      getRequiredLessons(db, null, { agentId: null, label: 'Build the gallery widget' }),
    ).toHaveLength(0);
  });
});

describe('automatic checks', () => {
  it('parses every form and runs them against the project folder', () => {
    const { root } = env.project();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'import fs from "fs";\nexport const x = 1;\n');
    writeFileSync(join(root, 'src', 'b.ts'), 'export const y = 2;\n');
    const run = (t: string) => runCheck(root, parseCheck(t));
    expect(run('file-exists README.md').passed).toBe(true);
    expect(run('file-exists nope.txt')).toMatchObject({
      passed: false,
      detail: 'nope.txt does not exist',
    });
    expect(run('file-missing nope.txt').passed).toBe(true);
    expect(run('file-missing README.md').passed).toBe(false);
    expect(run('no-match src/**/*.ts /from "fs"/').passed).toBe(false);
    expect(run('no-match src/**/*.ts /from "fs"/').detail).toContain('src/a.ts');
    expect(run('no-match src/b.ts /from "fs"/').passed).toBe(true);
    expect(run('must-match src/*.ts /export const y/').passed).toBe(true);
    expect(run('must-match src/*.ts /nothing like this/').passed).toBe(false);
    expect(globFiles(root, 'src/*.ts').sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(globFiles(root, '**/*.ts')).toHaveLength(2);
    expect(globFiles(root, 'details/*')).toEqual(['details/brief.md']);
  });

  it('runs a project npm script and reports its exit code', () => {
    const { root } = env.bare('npm');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'x',
        scripts: { good: 'node -e "process.exit(0)"', bad: 'node -e "process.exit(3)"' },
      }),
    );
    expect(runCheck(root, parseCheck('command npm run good'))).toMatchObject({ passed: true });
    const bad = runCheck(root, parseCheck('command npm run bad'));
    expect(bad.passed).toBe(false);
    expect(bad.detail).toMatch(/failed \(exit 3\)/);
    expect(runCheck(root, parseCheck('command npm run missing-script')).passed).toBe(false);
  }, 60_000);

  it('a task that breaks an automatic check goes back to In Progress naming the lesson, and the lesson counts it; a fix passes', () => {
    const { db, root } = env.project();
    addTask(db, 'T1', { label: 'Rewrite the landing page copy', assignee: 'operator' });
    reject(db, 'T1', 'Copy used the word "revolutionary"', {
      check: 'no-match **/*.md /revolutionary/i',
      checkType: 'automatic',
    });
    const id = lastLessonId(db);
    db.prepare("UPDATE subtasks SET status = 'in_progress' WHERE id = 'T1'").run();
    writeFileSync(join(root, 'landing.md'), 'A revolutionary shop.\n');
    transition(db, 'T1', 'complete', { summary: 'copy done' });
    expect(getTask(db, 'T1')?.status).toBe('review');
    const r = auditCompletedTask(db, env.lib, { taskId: 'T1', projectRoot: root });
    expect(r.sentBack).toBe(true);
    expect(getTask(db, 'T1')?.status).toBe('in_progress');
    const rej = getActivityFeed(db, { targetId: 'T1', limit: 10 }).find(
      (l) => l.action === 'task_rejected',
    );
    expect(rej?.agent_id).toBe('system');
    expect(rej?.description).toContain(`lesson #${id}`);
    expect(rej?.description).toContain('landing.md');
    expect(getLesson(db, id)?.occurrences).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM lessons_learned').get() as { n: number }).n).toBe(1);
    // fixed
    writeFileSync(join(root, 'landing.md'), 'A calm shop.\n');
    transition(db, 'T1', 'complete', { summary: 'reworded' });
    const ok = auditCompletedTask(db, env.lib, { taskId: 'T1', projectRoot: root });
    expect(ok.sentBack).toBe(false);
    expect(ok.outcomes).toMatchObject([{ lessonId: id, passed: true }]);
    expect(getTask(db, 'T1')?.status).toBe('review');
    expect(getLesson(db, id)?.occurrences).toBe(1);
  });

  it('two failures of the same check mark the lesson needs_rewrite; a library lesson fails the same way', () => {
    const { db, root } = env.project();
    const a = createLibraryAgent(env.lib, { name: 'Writer' });
    addTask(db, 'T1', { label: 'Landing page copy', assignee: 'operator' });
    reject(db, 'T1', 'banned word again', {
      check: 'no-match **/*.md /bannedword/',
      checkType: 'automatic',
    });
    const id = lastLessonId(db);
    writeFileSync(join(root, 'x.md'), 'bannedword\n');
    for (let i = 0; i < 2; i++) {
      db.prepare("UPDATE subtasks SET status = 'in_progress' WHERE id = 'T1'").run();
      transition(db, 'T1', 'complete', { summary: 's' });
      expect(auditCompletedTask(db, env.lib, { taskId: 'T1', projectRoot: root }).sentBack).toBe(
        true,
      );
    }
    expect(getLesson(db, id)).toMatchObject({ occurrences: 2, status: 'needs_rewrite' });

    const lib = addLibraryLesson(env.lib, {
      scope: 'global',
      rejectionReason: 'no draft marker in landing copy',
      checkText: 'no-match **/*.md /TODO/',
      checkType: 'automatic',
    });
    addTask(db, 'T2', { label: 'Landing page copy final', assignee: a.id });
    writeFileSync(join(root, 'x.md'), 'TODO later\n');
    db.prepare("UPDATE subtasks SET status = 'in_progress' WHERE id = 'T2'").run();
    transition(db, 'T2', 'complete', { summary: 's' });
    const r = auditCompletedTask(db, env.lib, { taskId: 'T2', projectRoot: root });
    expect(r.sentBack).toBe(true);
    expect(getRecentReason(db, 'T2')).toContain(`library lesson #${lib.id}`);
    expect(getLibraryLesson(env.lib, lib.id)?.occurrences).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM lessons_learned').get() as { n: number }).n).toBe(1); // none added for the library one
  });

  it('manual and draft lessons never fail a task; a check that cannot be parsed is skipped, not failed', () => {
    const { db, root } = env.project();
    addTask(db, 'T1', { label: 'Landing page copy', assignee: 'operator' });
    reject(db, 'T1', 'manual one about landing', {
      check: 'a reviewer ticks this',
      checkType: 'manual',
    });
    reject(db, 'T1', 'draft one about landing');
    db.prepare(
      "INSERT INTO lessons_learned (subtask_id, rejection_reason, fix_applied, check_text, check_type, status, created_at, scope) VALUES ('T1', 'broken check about landing', '', 'not a real check', 'automatic', 'active', '2026-01-01T00:00:00Z', 'project')",
    ).run();
    db.prepare("UPDATE subtasks SET status = 'in_progress' WHERE id = 'T1'").run();
    transition(db, 'T1', 'complete', { summary: 's' });
    const task = getTask(db, 'T1');
    const out = runLessonChecks(db, env.lib, {
      task: task as never,
      agentId: null,
      projectRoot: root,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ passed: true, skipped: true });
    expect(auditCompletedTask(db, env.lib, { taskId: 'T1', projectRoot: root }).sentBack).toBe(
      false,
    );
  });
});

const getRecentReason = (db: ReturnType<Env['project']>['db'], taskId: string) =>
  getActivityFeed(db, { targetId: taskId, limit: 10 }).find((l) => l.action === 'task_rejected')
    ?.description ?? '';
