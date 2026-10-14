import { z } from 'zod';
import { nowIso, write } from '../db';
import { CoreError, InvalidInputError, LessonNotFoundError } from '../errors';
import { validateCheck } from '../lesson-checks';
import { CHECK_TYPES, LESSON_STATUSES } from '../types';
import { getLibraryAgent } from './agents';
import type { LibraryDb } from './db';

// Lessons that apply beyond one project (D37): `agent` scope (one library agent, in every project it is assigned to) and
// `global` (every agent). They live in the library, which every project can read; a project lesson that is promoted is
// copied here and the project row records where it went.

export const LibraryLessonSchema = z.object({
  id: z.number(),
  scope: z.enum(['agent', 'global']),
  agent_id: z.string().nullable(),
  origin_project: z.string().nullable(),
  origin_lesson_id: z.number().nullable(),
  origin_task: z.string().nullable(),
  trigger_keywords: z.string(),
  rejection_reason: z.string(),
  fix_applied: z.string(),
  prevention: z.string(),
  check_text: z.string(),
  check_type: z.enum(CHECK_TYPES),
  occurrences: z.number(),
  status: z.enum(LESSON_STATUSES),
  created_at: z.string(),
  updated_at: z.string(),
});
export type LibraryLesson = z.infer<typeof LibraryLessonSchema>;

export function getLibraryLesson(lib: LibraryDb, id: number): LibraryLesson | null {
  const row = lib.prepare('SELECT * FROM lessons WHERE id = ?').get(id);
  return row ? LibraryLessonSchema.parse(row) : null;
}

export function listLibraryLessons(
  lib: LibraryDb,
  f: { scope?: 'agent' | 'global'; agentId?: string; status?: LibraryLesson['status'] } = {},
): LibraryLesson[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.scope) (where.push('scope = ?'), params.push(f.scope));
  if (f.agentId) (where.push('agent_id = ?'), params.push(f.agentId));
  if (f.status) (where.push('status = ?'), params.push(f.status));
  return LibraryLessonSchema.array().parse(
    lib
      .prepare(
        `SELECT * FROM lessons ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`,
      )
      .all(...params),
  );
}

export interface NewLibraryLesson {
  scope: 'agent' | 'global';
  agentId?: string | null;
  originProject?: string | null;
  originLessonId?: number | null;
  originTask?: string | null;
  triggerKeywords?: string;
  rejectionReason: string;
  fixApplied?: string;
  prevention?: string;
  checkText: string;
  checkType: 'automatic' | 'manual';
}

/** Insert an agent- or global-scope lesson into the library. It needs a check (D40): `draft`s do not get here. */
export function addLibraryLesson(lib: LibraryDb, o: NewLibraryLesson): LibraryLesson {
  if (o.scope === 'agent') {
    if (!o.agentId)
      throw new InvalidInputError('An agent-scope lesson needs the library agent it applies to.');
    if (!getLibraryAgent(lib, o.agentId))
      throw new CoreError(
        'LIBRARY_AGENT_NOT_FOUND',
        `Library agent '${o.agentId}' does not exist.`,
      );
  }
  if (!o.checkText.trim())
    throw new InvalidInputError(
      'A lesson needs a prevention check before it can apply beyond one project.',
    );
  if (o.checkType === 'automatic') validateCheck(o.checkText);
  const at = nowIso();
  const id = write(lib, () =>
    Number(
      lib
        .prepare(
          `INSERT INTO lessons (scope, agent_id, origin_project, origin_lesson_id, origin_task, trigger_keywords, rejection_reason,
             fix_applied, prevention, check_text, check_type, occurrences, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
        )
        .run(
          o.scope,
          o.scope === 'agent' ? o.agentId : null,
          o.originProject ?? null,
          o.originLessonId ?? null,
          o.originTask ?? null,
          o.triggerKeywords?.trim() ?? '',
          o.rejectionReason,
          o.fixApplied ?? '',
          o.prevention ?? '',
          o.checkText.trim(),
          o.checkType,
          at,
          at,
        ).lastInsertRowid,
    ),
  );
  return getLibraryLesson(lib, id) as LibraryLesson;
}

export function updateLibraryLesson(
  lib: LibraryDb,
  id: number,
  patch: Partial<
    Pick<
      LibraryLesson,
      | 'rejection_reason'
      | 'fix_applied'
      | 'prevention'
      | 'trigger_keywords'
      | 'check_text'
      | 'check_type'
      | 'status'
    >
  >,
): LibraryLesson {
  return write(lib, () => {
    const cur = getLibraryLesson(lib, id);
    if (!cur) throw new LessonNotFoundError(id);
    const next = { ...cur, ...patch, updated_at: nowIso() };
    if (!next.check_text.trim())
      throw new InvalidInputError('A promoted lesson keeps a prevention check.');
    if (next.check_type === 'automatic') validateCheck(next.check_text);
    lib
      .prepare(
        `UPDATE lessons SET rejection_reason = ?, fix_applied = ?, prevention = ?, trigger_keywords = ?, check_text = ?, check_type = ?,
           status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.rejection_reason,
        next.fix_applied,
        next.prevention,
        next.trigger_keywords,
        next.check_text,
        next.check_type === 'none' ? 'manual' : next.check_type,
        next.status,
        next.updated_at,
        id,
      );
    return getLibraryLesson(lib, id) as LibraryLesson;
  });
}

/** One more recurrence of the mistake; two or more make the lesson `needs_rewrite` (D39). */
export function recordLibraryRecurrence(lib: LibraryDb, id: number): LibraryLesson {
  return write(lib, () => {
    const cur = getLibraryLesson(lib, id);
    if (!cur) throw new LessonNotFoundError(id);
    const occurrences = cur.occurrences + 1;
    const status = occurrences >= 2 && cur.status === 'active' ? 'needs_rewrite' : cur.status;
    lib
      .prepare('UPDATE lessons SET occurrences = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(occurrences, status, nowIso(), id);
    return getLibraryLesson(lib, id) as LibraryLesson;
  });
}

export function deleteLibraryLesson(lib: LibraryDb, id: number): void {
  write(lib, () => {
    if (!getLibraryLesson(lib, id)) throw new LessonNotFoundError(id);
    lib.prepare('DELETE FROM lessons WHERE id = ?').run(id);
  });
}
