import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nowIso, write, type Db } from './db';
import { LessonNotFoundError } from './errors';
import { LessonSchema, type Lesson } from './types';

// Self-improving memory (blueprint Phase 12). The `lessons_learned` table is the source of truth;
// `.claude/LESSONS_LEARNED.md` is a rendered view of it that is rewritten after every change, so the two
// cannot drift. Retrieval is FTS5 over reason + fix + prevention (D7).

/** Insert a lesson. The FTS index is kept in sync by triggers (migrations 002, 004). */
export function addLesson(
  db: Db,
  subtaskId: string,
  rejectionReason: string,
  fixApplied = '',
  at = nowIso(),
  prevention = '',
): number {
  return write(db, () =>
    Number(
      db
        .prepare(
          'INSERT INTO lessons_learned (subtask_id, rejection_reason, fix_applied, prevention, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(subtaskId, rejectionReason, fixApplied, prevention, at).lastInsertRowid,
    ),
  );
}

export function getLesson(db: Db, id: number): Lesson | null {
  const row = db.prepare('SELECT * FROM lessons_learned WHERE id = ?').get(id);
  return row ? LessonSchema.parse(row) : null;
}

export interface LessonPatch {
  rejection_reason?: string;
  fix_applied?: string;
  prevention?: string;
}

/** Edit a lesson (what was wrong, how it was fixed, how to prevent it). Rewrites LESSONS_LEARNED.md. */
export function updateLesson(db: Db, id: number, patch: LessonPatch): Lesson {
  const lesson = write(db, () => {
    const cur = getLesson(db, id);
    if (!cur) throw new LessonNotFoundError(id);
    const next = {
      rejection_reason: patch.rejection_reason?.trim() || cur.rejection_reason,
      fix_applied: patch.fix_applied?.trim() ?? cur.fix_applied,
      prevention: patch.prevention?.trim() ?? cur.prevention,
    };
    db.prepare(
      'UPDATE lessons_learned SET rejection_reason = ?, fix_applied = ?, prevention = ? WHERE id = ?',
    ).run(next.rejection_reason, next.fix_applied, next.prevention, id);
    return { ...cur, ...next };
  });
  syncLessonsFile(db);
  return lesson;
}

export function deleteLesson(db: Db, id: number): void {
  write(db, () => {
    if (!getLesson(db, id)) throw new LessonNotFoundError(id);
    db.prepare('DELETE FROM lessons_learned WHERE id = ?').run(id);
  });
  syncLessonsFile(db);
}

/**
 * When a rejected task is completed again, the completion summary is how it was fixed: record it on the
 * task's newest lesson that has no fix yet.
 */
export function recordFixForTask(db: Db, taskId: string, summary: string): boolean {
  const fix = summary.trim();
  if (!fix) return false;
  const row = db
    .prepare(
      "SELECT id FROM lessons_learned WHERE subtask_id = ? AND fix_applied = '' ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(taskId) as { id: number } | undefined;
  if (!row) return false;
  db.prepare('UPDATE lessons_learned SET fix_applied = ? WHERE id = ?').run(fix, row.id);
  return true;
}

const STOP = new Set(
  'the and for with from this that into than then are was were has have not but you your its our add make use using get set run new via per one two all any can may out off too'.split(
    ' ',
  ),
);

function tokens(...parts: string[]): string[] {
  const words =
    parts
      .join(' ')
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)))];
}

/**
 * Lessons relevant to a task: FTS5 (bm25) over reason + fix + prevention, prefix-matched on the label and
 * keywords (D7). Falls back to LIKE when FTS finds nothing. Top 5 by default.
 */
export function getRelevantLessons(
  db: Db,
  taskLabel: string,
  keywords: string[] = [],
  limit = 5,
): Lesson[] {
  const toks = tokens(taskLabel, ...keywords);
  if (toks.length === 0) return [];

  const match = toks.map((t) => `"${t}"*`).join(' OR ');
  const fts = db
    .prepare(
      `SELECT l.* FROM lessons_fts JOIN lessons_learned l ON l.id = lessons_fts.rowid
       WHERE lessons_fts MATCH ? ORDER BY bm25(lessons_fts) LIMIT ?`,
    )
    .all(match, limit);
  if (fts.length > 0) return LessonSchema.array().parse(fts);

  const like = toks
    .map(() => '(rejection_reason LIKE ? OR fix_applied LIKE ? OR prevention LIKE ?)')
    .join(' OR ');
  const params = toks.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);
  return LessonSchema.array().parse(
    db
      .prepare(
        `SELECT * FROM lessons_learned WHERE ${like} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit),
  );
}

/**
 * Lessons for a task: its own rejections first (newest first), then lessons relevant to its topic
 * (FTS on the label and any extra keywords such as acceptance criteria), de-duplicated, up to `limit`.
 */
export function getLessonsForTask(
  db: Db,
  taskId: string,
  taskLabel: string,
  limit = 5,
  keywords: string[] = [],
): Lesson[] {
  const own = LessonSchema.array().parse(
    db
      .prepare(
        'SELECT * FROM lessons_learned WHERE subtask_id = ? ORDER BY created_at DESC, id DESC',
      )
      .all(taskId),
  );
  const seen = new Set(own.map((l) => l.id));
  const related = getRelevantLessons(db, taskLabel, keywords, limit).filter((l) => !seen.has(l.id));
  return [...own, ...related].slice(0, limit);
}

/** One line per lesson for prompts: `reason — fix: …; prevention: …`. */
export function lessonLine(l: Lesson): string {
  return [
    l.rejection_reason,
    l.fix_applied ? `fix: ${l.fix_applied}` : '',
    l.prevention ? `prevention: ${l.prevention}` : '',
  ]
    .filter(Boolean)
    .join(' — ');
}

// ---------------------------------------------------------------- LESSONS_LEARNED.md

const FILE_HEADER =
  '# Lessons Learned\n\n<!-- Generated from the lessons_learned table by Command Center. Edit lessons in the app; this file is rewritten on every change. -->\n';

const day = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0] ?? iso.slice(0, 10)).trim();

/** The file in the blueprint's format, oldest first (so it reads like an append-only log). */
export function renderLessonsMd(lessons: readonly Lesson[]): string {
  const ordered = [...lessons].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
  );
  const entries = ordered.map((l) =>
    [
      `## ${l.subtask_id} Rejection (${day(l.created_at)})`,
      '',
      '**Rejection Reason:**',
      l.rejection_reason,
      '',
      '**Fix Applied:**',
      l.fix_applied || '_Not recorded yet._',
      '',
      '**Prevention:**',
      l.prevention || '_Not recorded yet._',
    ].join('\n'),
  );
  return `${FILE_HEADER}\n${entries.join('\n\n')}${entries.length ? '\n' : ''}`;
}

/** `<project root>/.claude/LESSONS_LEARNED.md`, or null for an in-memory database. */
export function lessonsFilePath(db: Db): string | null {
  const file = db.name;
  if (!file || file === ':memory:' || file === '') return null;
  return join(dirname(file), '.claude', 'LESSONS_LEARNED.md');
}

/**
 * Rewrites the markdown file from the table (atomically, via a temp file). A file that cannot be written
 * (read-only folder, antivirus lock) never fails the database change that triggered it.
 */
export function syncLessonsFile(db: Db): string | null {
  const path = lessonsFilePath(db);
  if (!path) return null;
  try {
    const lessons = LessonSchema.array().parse(
      db.prepare('SELECT * FROM lessons_learned ORDER BY created_at ASC, id ASC').all(),
    );
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, renderLessonsMd(lessons), 'utf8');
    renameSync(tmp, path);
    return path;
  } catch {
    return null;
  }
}

/** Parses the generated file back into entries (used by tests and `doctor`-style checks). */
export function parseLessonsMd(
  md: string,
): { task: string; date: string; reason: string; fix: string; prevention: string }[] {
  const blocks = md.split(/^## /m).slice(1);
  return blocks.map((b) => {
    const head = /^(\S+) Rejection \((.*?)\)/.exec(b);
    const section = (label: string, next: string | null) => {
      const re = new RegExp(
        `\\*\\*${label}:\\*\\*\\n([\\s\\S]*?)${next ? `\\n\\n\\*\\*${next}:\\*\\*` : '\\s*$'}`,
      );
      return (re.exec(b)?.[1] ?? '').trim();
    };
    return {
      task: head?.[1] ?? '',
      date: head?.[2] ?? '',
      reason: section('Rejection Reason', 'Fix Applied'),
      fix: section('Fix Applied', 'Prevention'),
      prevention: section('Prevention', null),
    };
  });
}
