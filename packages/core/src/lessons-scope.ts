import { nowIso, write, type Db } from './db';
import { InvalidInputError, LessonNotFoundError } from './errors';
import { getLibraryAgent } from './library/agents';
import type { LibraryDb } from './library/db';
import { addLibraryLesson, LibraryLessonSchema, type LibraryLesson } from './library/lessons';
import { getLesson, syncLessonsFile, tokens } from './lessons';
import { logAction } from './queries';
import { LessonSchema, type Lesson } from './types';

// Lesson scopes and required reading (D37, D38, D40). A rejection makes a `project` lesson. The operator can promote it to
// one library agent (`agent`) or to every agent (`global`); promotion is never automatic and needs a prevention check.
// Before a run starts, every lesson that matches the agent, the project or everybody, and the task's words, is injected.

export type PromotionTarget = { scope: 'agent'; agentId: string } | { scope: 'global' };

export const NEEDS_CHECK =
  'This lesson has no prevention check, so it can only apply in this project. Add a check (a short, verifiable statement) first.';

/**
 * Copy a project lesson into the library as an agent- or global-scope lesson and mark the project row as promoted.
 * Refused for a lesson without a prevention check (D40), a retired one, or one that was already promoted.
 */
export function promoteLesson(
  db: Db,
  lib: LibraryDb,
  lessonId: number,
  target: PromotionTarget,
  o: { projectId?: string | null; actor?: string } = {},
): LibraryLesson {
  const lesson = getLesson(db, lessonId);
  if (!lesson) throw new LessonNotFoundError(lessonId);
  if (lesson.promoted_to)
    throw new InvalidInputError(
      `Lesson #${lessonId} was already promoted (${lesson.promoted_to}).`,
    );
  if (lesson.status === 'retired')
    throw new InvalidInputError('A retired lesson cannot be promoted.');
  if (lesson.check_type === 'none' || !lesson.check_text.trim() || lesson.status === 'draft')
    throw new InvalidInputError(NEEDS_CHECK);
  if (target.scope === 'agent' && !getLibraryAgent(lib, target.agentId))
    throw new InvalidInputError(`Library agent '${target.agentId}' does not exist.`);
  const made = addLibraryLesson(lib, {
    scope: target.scope,
    agentId: target.scope === 'agent' ? target.agentId : null,
    originProject: o.projectId ?? lesson.project_id,
    originLessonId: lesson.id,
    originTask: lesson.subtask_id,
    triggerKeywords: lesson.trigger_keywords,
    rejectionReason: lesson.rejection_reason,
    fixApplied: lesson.fix_applied,
    prevention: lesson.prevention,
    checkText: lesson.check_text,
    checkType: lesson.check_type === 'automatic' ? 'automatic' : 'manual',
  });
  const where = target.scope === 'agent' ? `agent:${target.agentId}` : 'global';
  write(db, () => {
    db.prepare(
      'UPDATE lessons_learned SET scope = ?, promoted_to = ?, agent_id = ?, updated_at = ? WHERE id = ?',
    ).run(
      target.scope,
      where,
      target.scope === 'agent' ? target.agentId : null,
      nowIso(),
      lessonId,
    );
    logAction(db, {
      agentId: o.actor ?? 'operator',
      action: 'lesson_promoted',
      targetType: 'lesson',
      targetId: String(lessonId),
      description: `Lesson #${lessonId} promoted to ${target.scope === 'agent' ? `agent ${getLibraryAgent(lib, target.agentId)?.name ?? target.agentId}` : 'global'}: ${lesson.rejection_reason.slice(0, 120)}`,
      tags: ['lesson', target.scope],
    });
  });
  syncLessonsFile(db);
  return made;
}

/** A project lesson set to `retired` stops being injected; it stays in the table. */
export function retireLesson(db: Db, lessonId: number): Lesson {
  return write(db, () => {
    if (!getLesson(db, lessonId)) throw new LessonNotFoundError(lessonId);
    db.prepare("UPDATE lessons_learned SET status = 'retired', updated_at = ? WHERE id = ?").run(
      nowIso(),
      lessonId,
    );
    return getLesson(db, lessonId) as Lesson;
  });
}

// ---------------------------------------------------------------- required reading

export interface RequiredLesson {
  /** `p:<id>` for a project lesson, `l:<id>` for a library one: unique across both stores. */
  key: string;
  source: 'project' | 'library';
  id: number;
  scope: 'project' | 'agent' | 'global';
  agent_id: string | null;
  task: string | null;
  reason: string;
  fix: string;
  prevention: string;
  check_text: string;
  check_type: 'automatic' | 'manual' | 'none';
  status: string;
  occurrences: number;
  created_at: string;
}

const SCOPE_RANK = { agent: 0, project: 1, global: 2 } as const;

const fromProject = (l: Lesson): RequiredLesson => ({
  key: `p:${l.id}`,
  source: 'project',
  id: l.id,
  scope: 'project',
  agent_id: null,
  task: l.subtask_id,
  reason: l.rejection_reason,
  fix: l.fix_applied,
  prevention: l.prevention,
  check_text: l.check_text,
  check_type: l.check_type,
  status: l.status,
  occurrences: l.occurrences,
  created_at: l.created_at,
});
const fromLibrary = (l: LibraryLesson): RequiredLesson => ({
  key: `l:${l.id}`,
  source: 'library',
  id: l.id,
  scope: l.scope,
  agent_id: l.agent_id,
  task: l.origin_task,
  reason: l.rejection_reason,
  fix: l.fix_applied,
  prevention: l.prevention,
  check_text: l.check_text,
  check_type: l.check_type,
  status: l.status,
  occurrences: l.occurrences,
  created_at: l.created_at,
});

/**
 * Every lesson a run must read (D38): project lessons that match the task's words, agent-scope lessons for THIS library
 * agent, and global lessons. Matching is FTS5 over the trigger keywords, the reason, the fix and the prevention rule, never
 * a model. Retired lessons and project lessons that were promoted (the library copy applies) are left out; library lessons
 * must be active (drafts do not exist there). The task's own earlier rejections always come first in the project group.
 * Ordered agent, project, global, then newest first; capped (default 10).
 */
export function getRequiredLessons(
  db: Db,
  lib: LibraryDb | null,
  o: {
    agentId: string | null;
    taskId?: string | undefined;
    label: string;
    keywords?: string[];
    limit?: number;
  },
): RequiredLesson[] {
  const limit = o.limit ?? 10;
  const toks = tokens(o.label, ...(o.keywords ?? []));
  const match = toks.map((t) => `"${t}"*`).join(' OR ');
  const found = new Map<string, RequiredLesson>();
  const add = (l: RequiredLesson) => found.has(l.key) || found.set(l.key, l);

  if (o.taskId) {
    const own = db
      .prepare(
        "SELECT * FROM lessons_learned WHERE subtask_id = ? AND status != 'retired' AND promoted_to IS NULL ORDER BY created_at DESC, id DESC",
      )
      .all(o.taskId);
    for (const l of LessonSchema.array().parse(own)) add(fromProject(l));
  }
  if (match) {
    const rows = db
      .prepare(
        `SELECT l.* FROM lessons_fts JOIN lessons_learned l ON l.id = lessons_fts.rowid
         WHERE lessons_fts MATCH ? AND l.status != 'retired' AND l.promoted_to IS NULL`,
      )
      .all(match);
    for (const l of LessonSchema.array().parse(rows)) add(fromProject(l));
    if (lib) {
      const lrows = lib
        .prepare(
          `SELECT l.* FROM lessons_fts JOIN lessons l ON l.id = lessons_fts.rowid
           WHERE lessons_fts MATCH ? AND l.status IN ('active','needs_rewrite')
             AND (l.scope = 'global' OR (l.scope = 'agent' AND l.agent_id = ?))`,
        )
        .all(match, o.agentId ?? '');
      for (const l of LibraryLessonSchema.array().parse(lrows)) add(fromLibrary(l));
    }
  }
  const own = (l: RequiredLesson) =>
    o.taskId && l.source === 'project' && l.task === o.taskId ? 0 : 1;
  return [...found.values()]
    .sort(
      (a, b) =>
        SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
        own(a) - own(b) ||
        b.created_at.localeCompare(a.created_at) ||
        b.id - a.id,
    )
    .slice(0, limit);
}

/** The "Before you start" block injected into a run's prompt (D38). Empty string when there is nothing to read. */
export function formatLessonsBlock(lessons: readonly RequiredLesson[]): string {
  if (lessons.length === 0) return '';
  const lines = lessons.map((l, i) => {
    const parts = [
      l.reason,
      l.fix ? `Fix: ${l.fix}` : '',
      l.prevention ? `Prevention: ${l.prevention}` : '',
      l.check_text ? `Check (${l.check_type}): ${l.check_text}` : '',
    ].filter(Boolean);
    return `${i + 1}. [${l.scope}${l.status === 'needs_rewrite' ? ', keeps recurring' : ''}] ${parts.join(' ')}`;
  });
  return `## Before you start\nThese are mistakes already made and corrected. Read them and do not repeat them.\n${lines.join('\n')}`;
}
