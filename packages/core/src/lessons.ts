import { nowIso, write, type Db } from './db';
import { LessonSchema, type Lesson } from './types';

/** Insert a lesson. The FTS index is kept in sync by triggers (migration 002). */
export function addLesson(
  db: Db,
  subtaskId: string,
  rejectionReason: string,
  fixApplied = '',
  at = nowIso(),
): number {
  return write(db, () =>
    Number(
      db
        .prepare(
          'INSERT INTO lessons_learned (subtask_id, rejection_reason, fix_applied, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(subtaskId, rejectionReason, fixApplied, at).lastInsertRowid,
    ),
  );
}

function tokens(...parts: string[]): string[] {
  const words =
    parts
      .join(' ')
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g) ?? [];
  return [...new Set(words)];
}

/**
 * Lessons relevant to a task: FTS5 (bm25) over reason + fix, prefix-matched on the label and
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

  const like = toks.map(() => '(rejection_reason LIKE ? OR fix_applied LIKE ?)').join(' OR ');
  const params = toks.flatMap((t) => [`%${t}%`, `%${t}%`]);
  return LessonSchema.array().parse(
    db
      .prepare(
        `SELECT * FROM lessons_learned WHERE ${like} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit),
  );
}
