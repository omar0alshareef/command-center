import type { Db } from './db';
import { getRelevantLessons } from './lessons';
import { getProject, getTask, listPhases, listTasks } from './queries';

const DAY_MS = 86_400_000;

/** 1-based project week for `now`, never below 1. Dates are UTC `YYYY-MM-DD`. */
export function currentWeek(startDate: string, now: Date): number {
  const days = Math.floor((now.getTime() - Date.parse(startDate)) / DAY_MS);
  return Math.max(1, Math.floor(days / 7) + 1);
}

/** The one-line string agents get injected: `WEEK 4, Phase: Build, Progress: 42%, ...`. */
export function buildContextString(db: Db, now = new Date()): string {
  const project = getProject(db);
  const week = currentWeek(project.start_date, now);
  const phase = listPhases(db).find((p) => p.start_week <= week && week <= p.end_week);
  const tasks = listTasks(db);
  const done = tasks.filter((t) => t.status === 'done').length;
  const progress = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100);
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  return `WEEK ${week}, Phase: ${phase?.title ?? 'none'}, Progress: ${progress}%, Schedule: ${project.schedule_status}, Blocked: ${blocked}`;
}

const list = (items: string[]): string =>
  items.length === 0 ? '_None._' : items.map((i) => `- ${i}`).join('\n');

/** Content of `.claude/TASK_CONTEXT.md`: the six sections an agent needs for one task. */
export function buildTaskContextMd(db: Db, taskId: string, now = new Date()): string | null {
  const task = getTask(db, taskId);
  if (!task) return null;
  const lessons = getRelevantLessons(db, task.label).map(
    (l) => `${l.rejection_reason}${l.fix_applied ? ` — fix: ${l.fix_applied}` : ''}`,
  );
  const description = [task.notes, task.prompt].filter(Boolean).join('\n\n') || '_None._';
  const criteria = task.acceptance_criteria.map((c) => `[${c.done ? 'x' : ' '}] ${c.text}`);
  return [
    `# ${task.id}: ${task.label}`,
    `_${buildContextString(db, now)}_`,
    `## Task description\n${description}`,
    `## Acceptance criteria\n${list(criteria)}`,
    `## Context files\n${list(task.context_files)}`,
    `## Reference docs\n${list(task.reference_docs)}`,
    `## Constraints\n${list(task.constraints)}`,
    `## Relevant lessons\n${list(lessons)}`,
  ].join('\n\n');
}
