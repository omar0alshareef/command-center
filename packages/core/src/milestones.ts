import { z } from 'zod';
import { nowIso, write, type Db } from './db';
import { InvalidInputError, MilestoneNotFoundError } from './errors';
import { getMilestone, getProject, listMilestones, listPhases, logAction } from './queries';
import { toJson, type Milestone, type MilestoneNote } from './types';

const DAY_MS = 86_400_000;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
  .refine(
    (s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
    'not a real calendar date',
  );

const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);

function need(db: Db, id: string): Milestone {
  const m = getMilestone(db, id);
  if (!m) throw new MilestoneNotFoundError(id);
  return m;
}

/** project.schedule_status follows the worst milestone drift: >= 7 days behind, >= 1 at risk. */
export function scheduleStatusFor(maxDriftDays: number): 'on_track' | 'at_risk' | 'behind' {
  return maxDriftDays >= 7 ? 'behind' : maxDriftDays >= 1 ? 'at_risk' : 'on_track';
}

function touch(
  db: Db,
  id: string,
  sets: string,
  params: Record<string, unknown>,
  at: string,
): void {
  db.prepare(`UPDATE milestones SET ${sets}, updated_at = @at WHERE id = @id`).run({
    ...params,
    id,
    at,
  });
}

export function addMilestoneNote(
  db: Db,
  milestoneId: string,
  rawText: string,
  author: string,
): Milestone {
  const text = z.string().trim().min(1).max(2000).parse(rawText);
  return write(db, () => {
    const m = need(db, milestoneId);
    const at = nowIso();
    const note: MilestoneNote = { text, author, at };
    touch(db, milestoneId, 'notes = @notes', { notes: toJson([...m.notes, note]) }, at);
    logAction(db, {
      agentId: author,
      action: 'milestone_note_added',
      targetType: 'milestone',
      targetId: milestoneId,
      description: `${milestoneId}: ${text.slice(0, 120)}`,
      tags: ['note'],
      at,
    });
    return need(db, milestoneId);
  });
}

export const MilestoneDatesSchema = z
  .object({
    planned_start: isoDate.nullable(),
    planned_end: isoDate.nullable(),
    actual_start: isoDate.nullable(),
    actual_end: isoDate.nullable(),
  })
  .partial()
  .strict();

/** Set any of the four milestone dates (YYYY-MM-DD or null). Only provided keys change. */
export function setMilestoneDates(
  db: Db,
  milestoneId: string,
  raw: unknown,
  actor: string,
): Milestone {
  const dates = MilestoneDatesSchema.parse(raw);
  const keys = Object.keys(dates) as (keyof typeof dates)[];
  if (keys.length === 0)
    throw new InvalidInputError(
      'Provide at least one of planned_start, planned_end, actual_start, actual_end.',
    );
  return write(db, () => {
    const m = need(db, milestoneId);
    const merged = { ...m, ...dates };
    if (merged.planned_start && merged.planned_end && merged.planned_end < merged.planned_start) {
      throw new InvalidInputError('planned_end is before planned_start.');
    }
    if (merged.actual_start && merged.actual_end && merged.actual_end < merged.actual_start) {
      throw new InvalidInputError('actual_end is before actual_start.');
    }
    const at = nowIso();
    touch(db, milestoneId, keys.map((k) => `${k} = @${k}`).join(', '), dates, at);
    logAction(db, {
      agentId: actor,
      action: 'milestone_dates_set',
      targetType: 'milestone',
      targetId: milestoneId,
      description: `${milestoneId}: ${keys.map((k) => `${k}=${dates[k] ?? 'none'}`).join(', ')}`,
      tags: ['dates'],
      at,
    });
    return need(db, milestoneId);
  });
}

/** Record schedule drift in days (positive = late), optionally with a reason, and refresh the project's status. */
export function updateDrift(
  db: Db,
  milestoneId: string,
  rawDays: number,
  actor: string,
  reason?: string,
): Milestone {
  const days = z.number().int().min(-365).max(365).parse(rawDays);
  return write(db, () => {
    const m = need(db, milestoneId);
    const at = nowIso();
    const notes = reason?.trim()
      ? [
          ...m.notes,
          { text: `Drift ${days >= 0 ? '+' : ''}${days}d: ${reason.trim()}`, author: actor, at },
        ]
      : m.notes;
    touch(
      db,
      milestoneId,
      'drift_days = @days, notes = @notes',
      { days, notes: toJson(notes) },
      at,
    );
    const maxDrift = Math.max(0, ...listMilestones(db).map((x) => x.drift_days));
    db.prepare('UPDATE project SET schedule_status = ? WHERE id = 1').run(
      scheduleStatusFor(maxDrift),
    );
    logAction(db, {
      agentId: actor,
      action: 'milestone_drift_updated',
      targetType: 'milestone',
      targetId: milestoneId,
      description: `${milestoneId}: drift ${m.drift_days}d -> ${days}d${reason?.trim() ? ` (${reason.trim()})` : ''}`,
      tags: ['drift'],
      at,
    });
    return need(db, milestoneId);
  });
}

export const NewMilestoneSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'use letters, digits, - _ (max 32 chars)')
    .optional(),
  title: z.string().trim().min(1).max(200),
  domain: z.string().trim().min(1).max(60).default('general'),
  week: z.number().int().min(1).max(520).default(1),
  phase: z.string().nullable().optional(),
  planned_start: isoDate.optional(),
  planned_end: isoDate.optional(),
  is_key_milestone: z.boolean().optional(),
  key_milestone_label: z.string().max(80).nullable().optional(),
  dependencies: z.array(z.string()).max(50).optional(),
});
export type NewMilestone = z.input<typeof NewMilestoneSchema>;

/** Create a milestone. Missing id -> next `M<n>`; missing dates -> derived from the project start and `week`. */
export function createMilestone(db: Db, raw: NewMilestone, actor: string): Milestone {
  const input = NewMilestoneSchema.parse(raw);
  return write(db, () => {
    const id =
      input.id ??
      `M${((db.prepare("SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) AS n FROM milestones WHERE id GLOB 'M[0-9]*'").get() as { n: number | null }).n ?? 0) + 1}`;
    if (getMilestone(db, id)) throw new InvalidInputError(`Milestone ${id} already exists.`);
    if (input.phase && !listPhases(db).some((p) => p.id === input.phase)) {
      throw new InvalidInputError(
        `Unknown phase '${input.phase}'. Existing phases: ${
          listPhases(db)
            .map((p) => p.id)
            .join(', ') || 'none'
        }.`,
      );
    }
    const deps = input.dependencies ?? [];
    for (const d of deps) {
      if (d === id) throw new InvalidInputError('A milestone cannot depend on itself.');
      if (!getMilestone(db, d)) throw new MilestoneNotFoundError(d);
    }
    const start = getProject(db).start_date;
    const plannedStart = input.planned_start ?? addDays(start, (input.week - 1) * 7);
    const plannedEnd = input.planned_end ?? addDays(plannedStart, 6);
    if (plannedEnd < plannedStart)
      throw new InvalidInputError('planned_end is before planned_start.');
    const at = nowIso();
    db.prepare(
      `INSERT INTO milestones (id, title, domain, week, phase, planned_start, planned_end, is_key_milestone,
         key_milestone_label, dependencies, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.domain,
      input.week,
      input.phase ?? null,
      plannedStart,
      plannedEnd,
      input.is_key_milestone ? 1 : 0,
      input.is_key_milestone
        ? (input.key_milestone_label ?? input.title)
        : (input.key_milestone_label ?? null),
      toJson(deps),
      at,
      at,
    );
    logAction(db, {
      agentId: actor,
      action: 'milestone_created',
      targetType: 'milestone',
      targetId: id,
      description: `${id}: created "${input.title}" (${input.domain}, week ${input.week})`,
      tags: ['create'],
      at,
    });
    return need(db, id);
  });
}
