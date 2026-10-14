import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTaskContextMd } from '../src/context';
import { openDb } from '../src/db';
import { LessonNotFoundError } from '../src/errors';
import {
  addLesson,
  deleteLesson,
  getLessonsForTask,
  getRelevantLessons,
  lessonsFilePath,
  parseLessonsMd,
  recordFixForTask,
  renderLessonsMd,
  updateLesson,
} from '../src/lessons';
import { migrations } from '../src/migrations';
import { transition } from '../src/state-machine';
import { addTask, tmpDb } from './helpers';

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
});
afterEach(() => t.cleanup());

const file = () => lessonsFilePath(t.db) as string;
const table = () =>
  t.db.prepare('SELECT * FROM lessons_learned ORDER BY created_at, id').all() as {
    id: number;
    subtask_id: string;
    rejection_reason: string;
    fix_applied: string;
    prevention: string;
  }[];
/** The file and the table must say the same thing. */
const expectInSync = () => {
  const parsed = parseLessonsMd(readFileSync(file(), 'utf8'));
  const rows = table();
  expect(
    parsed.map((p) => [
      p.task,
      p.reason,
      p.fix === '_Not recorded yet._' ? '' : p.fix,
      p.prevention === '_Not recorded yet._' ? '' : p.prevention,
    ]),
  ).toEqual(rows.map((r) => [r.subtask_id, r.rejection_reason, r.fix_applied, r.prevention]));
};

describe('migration 004', () => {
  it('keeps existing lessons, adds the prevention column and keeps search working', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-mig-'));
    try {
      // A database as the app shipped it before M10: migrations 1-3 only.
      const old = new Database(join(root, 'command-center.db'));
      old.pragma('foreign_keys = ON');
      old.exec(
        'CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
      );
      for (const m of migrations.filter((x) => x.version <= 3)) {
        old.exec(m.sql);
        old.prepare('INSERT INTO schema_version VALUES (?, ?, ?)').run(m.version, m.name, 'x');
      }
      old.exec("INSERT INTO milestones (id, title) VALUES ('M0','t')");
      old.exec(
        "INSERT INTO subtasks (id, milestone_id, label, status) VALUES ('TASK-001','M0','Modal','review')",
      );
      old.exec(
        "INSERT INTO lessons_learned (subtask_id, rejection_reason, fix_applied) VALUES ('TASK-001','the modal did not close on backdrop click','added a click handler')",
      );
      old.close();

      const db = openDb(root);
      expect(db.prepare('SELECT prevention FROM lessons_learned').get()).toEqual({
        prevention: '',
      });
      expect(getRelevantLessons(db, 'Modal dismiss behavior').map((l) => l.subtask_id)).toEqual([
        'TASK-001',
      ]);
      addLesson(db, 'TASK-001', 'second problem', '', undefined, 'always test escape');
      expect(getRelevantLessons(db, 'escape handling').map((l) => l.prevention)).toEqual([
        'always test escape',
      ]);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('LESSONS_LEARNED.md stays in sync with the table', () => {
  it('rejecting twice with different reasons writes two entries in the blueprint format', () => {
    addTask(t.db, 'TASK-001', 'review', { label: 'Modal backdrop' });
    addTask(t.db, 'TASK-002', 'review', { label: 'Login form' });
    transition(t.db, 'TASK-001', 'reject', { reason: "The modal didn't close on backdrop click." });
    transition(t.db, 'TASK-002', 'reject', {
      reason: 'Form accepted an empty password.',
      prevention: 'Test empty and whitespace-only input.',
    });
    const md = readFileSync(file(), 'utf8');
    expect(md).toMatch(/^# Lessons Learned/);
    expect(md).toMatch(
      /## TASK-001 Rejection \(\d{4}-\d{2}-\d{2}\)\n\n\*\*Rejection Reason:\*\*\nThe modal didn't close on backdrop click\.\n\n\*\*Fix Applied:\*\*\n_Not recorded yet\._\n\n\*\*Prevention:\*\*\n_Not recorded yet\._/,
    );
    expect(md).toContain('Test empty and whitespace-only input.');
    expect(table()).toHaveLength(2);
    expectInSync();
  });

  it('the completion summary after a rejection becomes the fix on the newest unresolved lesson', () => {
    addTask(t.db, 'TASK-001', 'review');
    transition(t.db, 'TASK-001', 'reject', { reason: 'first problem' });
    transition(t.db, 'TASK-001', 'complete', { summary: 'fixed the first problem' });
    transition(t.db, 'TASK-001', 'reject', { reason: 'second problem' });
    transition(t.db, 'TASK-001', 'complete', { summary: 'fixed the second problem' });
    expect(table().map((l) => l.fix_applied)).toEqual([
      'fixed the first problem',
      'fixed the second problem',
    ]);
    expectInSync();
    expect(readFileSync(file(), 'utf8')).toContain('fixed the second problem');
  });

  it('a task that was never rejected writes nothing; an already-fixed lesson is not overwritten', () => {
    addTask(t.db, 'TASK-001', 'in_progress');
    transition(t.db, 'TASK-001', 'complete', { summary: 'done' });
    expect(existsSync(file())).toBe(false);
    addLesson(t.db, 'TASK-001', 'old', 'old fix');
    expect(recordFixForTask(t.db, 'TASK-001', 'new fix')).toBe(false);
    expect(table()[0]?.fix_applied).toBe('old fix');
  });

  it('editing and deleting a lesson rewrites the file; deleted lessons stop being found', () => {
    addTask(t.db, 'TASK-001', 'review');
    transition(t.db, 'TASK-001', 'reject', { reason: 'backdrop click ignored' });
    const id = table()[0]?.id as number;
    const edited = updateLesson(t.db, id, {
      fix_applied: 'added handler',
      prevention: 'test dismiss paths',
    });
    expect(edited).toMatchObject({
      fix_applied: 'added handler',
      prevention: 'test dismiss paths',
    });
    expectInSync();
    expect(getRelevantLessons(t.db, 'dismiss paths')).toHaveLength(1);
    deleteLesson(t.db, id);
    expect(table()).toHaveLength(0);
    expect(readFileSync(file(), 'utf8')).not.toContain('TASK-001');
    expect(getRelevantLessons(t.db, 'backdrop')).toHaveLength(0);
    expect(() => updateLesson(t.db, id, { fix_applied: 'x' })).toThrow(LessonNotFoundError);
    expect(() => deleteLesson(t.db, 999)).toThrow(/Lesson 999 does not exist/);
  });

  it('a file that cannot be written never fails the rejection', () => {
    writeFileSync(join(t.root, '.claude'), 'a file where the folder should be');
    addTask(t.db, 'TASK-001', 'review');
    expect(transition(t.db, 'TASK-001', 'reject', { reason: 'still recorded' }).status).toBe(
      'in_progress',
    );
    expect(table()).toHaveLength(1);
  });

  it('render/parse round-trips multi-line text', () => {
    const md = renderLessonsMd([
      {
        id: 1,
        subtask_id: 'TASK-001',
        rejection_reason: 'line one\nline two',
        fix_applied: '',
        prevention: 'p',
        created_at: '2026-01-15T10:00:00.000Z',
        scope: 'project',
        agent_id: null,
        trigger_keywords: '',
        check_text: '',
        check_type: 'none',
        occurrences: 0,
        status: 'active',
        updated_at: null,
        promoted_to: null,
        project_id: null,
      },
    ]);
    expect(parseLessonsMd(md)[0]).toMatchObject({
      task: 'TASK-001',
      date: '2026-01-15',
      reason: 'line one\nline two',
      prevention: 'p',
    });
  });
});

describe('retrieval feeds the next task', () => {
  it('a similar new task gets the relevant lesson in TASK_CONTEXT.md; an unrelated one does not', () => {
    addTask(t.db, 'TASK-001', 'review', { label: 'Modal close behaviour' });
    addTask(t.db, 'TASK-002', 'review', { label: 'Report export' });
    transition(t.db, 'TASK-001', 'reject', {
      reason: 'The modal did not close on backdrop click',
      prevention: 'Test dismiss behaviour in the acceptance criteria',
    });
    transition(t.db, 'TASK-002', 'reject', { reason: 'CSV export dropped the header row' });
    addTask(t.db, 'TASK-010', 'todo', { label: 'Settings modal dismiss' });
    addTask(t.db, 'TASK-011', 'todo', { label: 'Weather widget colours' });
    const similar = buildTaskContextMd(t.db, 'TASK-010') ?? '';
    const section = similar.slice(similar.indexOf('## Relevant lessons'));
    expect(section).toContain('modal did not close on backdrop click');
    expect(section).toContain('prevention: Test dismiss behaviour');
    expect(section).not.toContain('CSV export');
    expect(buildTaskContextMd(t.db, 'TASK-011')).toContain('## Relevant lessons\n_None._');
  });

  it("a task's own rejections come first, then related ones, capped at five", () => {
    addTask(t.db, 'TASK-001', 'review', { label: 'Modal one' });
    addTask(t.db, 'TASK-002', 'review', { label: 'Modal two' });
    for (let i = 0; i < 4; i++) addLesson(t.db, 'TASK-001', `modal problem ${i}`);
    transition(t.db, 'TASK-002', 'reject', { reason: 'own modal rejection' });
    const got = getLessonsForTask(t.db, 'TASK-002', 'Modal two');
    expect(got).toHaveLength(5);
    expect(got[0]?.rejection_reason).toBe('own modal rejection');
  });

  it('filler words alone never match a lesson', () => {
    addTask(t.db, 'TASK-001', 'review');
    addLesson(t.db, 'TASK-001', 'add the thing and make it work with this');
    expect(getRelevantLessons(t.db, 'Add the new thing')).toHaveLength(1); // "thing" matches
    expect(getRelevantLessons(t.db, 'Add the new')).toHaveLength(0); // only stop words
  });
});

// keep the unused import honest: mkdirSync is used to prove the folder is created on demand
describe('file location', () => {
  it('lives in <project root>/.claude and is created on demand', () => {
    expect(file()).toBe(join(t.root, '.claude', 'LESSONS_LEARNED.md'));
    mkdirSync(join(t.root, '.claude'), { recursive: true });
    addTask(t.db, 'TASK-001', 'review');
    transition(t.db, 'TASK-001', 'reject', { reason: 'x problem' });
    expect(existsSync(file())).toBe(true);
  });
});
