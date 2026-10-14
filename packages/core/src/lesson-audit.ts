import type { Db } from './db';
import { parseCheck, runCheck } from './lesson-checks';
import { recordRecurrence } from './lessons';
import { getRequiredLessons, type RequiredLesson } from './lessons-scope';
import type { LibraryDb } from './library/db';
import { recordLibraryRecurrence } from './library/lessons';
import { getTask } from './queries';
import { transition } from './state-machine';
import type { Task } from './types';

// Automatic prevention checks (D40, M9 audit integration). When a task reaches Review, every lesson that applies to it and
// carries an automatic check is run. A failed check sends the task back to In Progress with the lesson named in the reason,
// and counts a recurrence of that mistake (two make the lesson `needs_rewrite`). The same checks pass on a fixed task.

export interface CheckOutcome {
  source: 'project' | 'library';
  lessonId: number;
  scope: RequiredLesson['scope'];
  check: string;
  passed: boolean;
  detail: string;
  /** The check text could not be parsed: reported, but it never fails a task. */
  skipped?: boolean;
}

export const lessonName = (o: Pick<CheckOutcome, 'source' | 'lessonId'>) =>
  `${o.source === 'library' ? 'library lesson' : 'lesson'} #${o.lessonId}`;

/** Run the automatic checks of every lesson that applies to this task. Pure with respect to the board: it only reads. */
export function runLessonChecks(
  db: Db,
  lib: LibraryDb | null,
  o: { task: Task; agentId: string | null; projectRoot: string },
): CheckOutcome[] {
  const lessons = getRequiredLessons(db, lib, {
    agentId: o.agentId,
    taskId: o.task.id,
    label: o.task.label,
    keywords: o.task.acceptance_criteria.map((c) => c.text),
    limit: 50,
  }).filter((l) => l.check_type === 'automatic' && l.check_text.trim() && l.status !== 'draft');
  return lessons.map((l) => {
    const base = { source: l.source, lessonId: l.id, scope: l.scope, check: l.check_text } as const;
    try {
      const r = runCheck(o.projectRoot, parseCheck(l.check_text));
      return { ...base, passed: r.passed, detail: r.detail };
    } catch (e) {
      return {
        ...base,
        passed: true,
        skipped: true,
        detail: `skipped: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  });
}

/**
 * Audit a task that just reached Review. On a failed check the task goes back to In Progress (a `reject` by the system) with
 * the lesson ids in the reason and each failed lesson's `occurrences` increased; no new lesson is created for it.
 */
export function auditCompletedTask(
  db: Db,
  lib: LibraryDb | null,
  o: { taskId: string; agentId?: string | null; projectRoot: string },
): { outcomes: CheckOutcome[]; sentBack: boolean } {
  const task = getTask(db, o.taskId);
  if (!task || task.status !== 'review') return { outcomes: [], sentBack: false };
  const outcomes = runLessonChecks(db, lib, {
    task,
    agentId: o.agentId ?? task.assignee,
    projectRoot: o.projectRoot,
  });
  const failed = outcomes.filter((x) => !x.passed);
  if (failed.length === 0) return { outcomes, sentBack: false };
  const reason =
    `Automatic check failed: ${failed.map((f) => `${lessonName(f)} (${f.detail})`).join('; ')}`.slice(
      0,
      900,
    );
  const firstProject = failed.find((f) => f.source === 'project');
  for (const f of failed) {
    if (f.source === 'library' && lib) recordLibraryRecurrence(lib, f.lessonId);
    else if (f.source === 'project' && f !== firstProject) recordRecurrence(db, f.lessonId);
  }
  transition(db, o.taskId, 'reject', {
    actor: 'system',
    reason,
    ...(firstProject ? { sameAs: firstProject.lessonId } : { noLesson: true }),
  });
  return { outcomes, sentBack: true };
}
