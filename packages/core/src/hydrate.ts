import { z } from 'zod';
import { nowIso, write, type Db } from './db';
import { InvalidInputError } from './errors';
import { AgentInputSchema, registerAgent } from './agents';
import { createMilestone, NewMilestoneSchema } from './milestones';
import { logAction } from './queries';
import { createTask } from './tasks';
import { PRIORITIES } from './types';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

/**
 * What "hydrate" accepts: the project, phases, agent roster and milestones with their subtasks, as
 * extracted from a manifesto and roadmap (blueprint "Post-build: hydration notice").
 */
export const HydratePlanSchema = z.strictObject({
  project: z
    .strictObject({
      name: z.string().trim().min(1).max(120).optional(),
      start_date: isoDate.optional(),
      target_date: isoDate.optional(),
    })
    .optional(),
  phases: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),
        title: z.string().trim().min(1).max(120),
        start_week: z.number().int().min(1).max(520),
        end_week: z.number().int().min(1).max(520),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
      }),
    )
    .default([]),
  agents: z.array(AgentInputSchema).default([]),
  milestones: z
    .array(
      NewMilestoneSchema.extend({
        tasks: z
          .array(
            z.strictObject({
              label: z.string().trim().min(1),
              priority: z.enum(PRIORITIES).optional(),
              assignee: z.string().nullable().optional(),
              acceptance_criteria: z.array(z.string().trim().min(1)).max(30).optional(),
              notes: z.string().optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});
export type HydratePlan = z.input<typeof HydratePlanSchema>;

export interface HydrateSummary {
  phases: number;
  agents: number;
  milestones: number;
  tasks: number;
  dryRun: boolean;
}

class DryRun extends Error {}

/**
 * Create phases, agents, milestones and subtasks from one plan, all in a single transaction: a bad
 * reference anywhere leaves the board untouched. `dryRun` validates and counts, then rolls back.
 * Everything goes through the same core functions the app, MCP server and webhook use.
 */
export function hydrate(db: Db, rawPlan: unknown, opts: { dryRun?: boolean } = {}): HydrateSummary {
  const plan = HydratePlanSchema.parse(rawPlan);
  const summary: HydrateSummary = {
    phases: plan.phases.length,
    agents: plan.agents.length,
    milestones: plan.milestones.length,
    tasks: plan.milestones.reduce((n, m) => n + m.tasks.length, 0),
    dryRun: Boolean(opts.dryRun),
  };
  try {
    write(db, () => {
      if (plan.project) {
        const p = plan.project;
        const sets = Object.entries(p).map(([k]) => `${k} = @${k}`);
        if (sets.length > 0)
          db.prepare(`UPDATE project SET ${sets.join(', ')} WHERE id = 1`).run(p);
      }
      for (const ph of plan.phases) {
        if (ph.end_week < ph.start_week)
          throw new InvalidInputError(`Phase ${ph.id}: end_week is before start_week.`);
        db.prepare(
          'INSERT OR REPLACE INTO phases (id, title, start_week, end_week, color) VALUES (?, ?, ?, ?, ?)',
        ).run(ph.id, ph.title, ph.start_week, ph.end_week, ph.color ?? '#585CF0');
      }
      for (const a of plan.agents) registerAgent(db, a);
      for (const { tasks, ...m } of plan.milestones) {
        const created = createMilestone(db, m, 'operator');
        for (const t of tasks) {
          createTask(
            db,
            {
              milestoneId: created.id,
              label: t.label,
              priority: t.priority,
              assignee: t.assignee,
              fields: {
                ...(t.notes ? { notes: t.notes } : {}),
                ...(t.acceptance_criteria
                  ? {
                      acceptance_criteria: t.acceptance_criteria.map((text) => ({
                        text,
                        done: false,
                      })),
                    }
                  : {}),
              },
            },
            'operator',
          );
        }
      }
      logAction(db, {
        agentId: 'operator',
        action: 'project_hydrated',
        description: `Hydrated: ${summary.phases} phases, ${summary.agents} agents, ${summary.milestones} milestones, ${summary.tasks} tasks`,
        tags: ['hydrate'],
        at: nowIso(),
      });
      if (opts.dryRun) throw new DryRun();
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  return summary;
}

/** The extraction prompt for an agent: the two documents plus the exact JSON the importer expects. */
export function hydrationPrompt(manifesto: string, roadmap: string): string {
  return `You are populating a Command Center project board. Read the manifesto and the roadmap below and
reply with ONE JSON object (no prose, no code fence) in this shape. Every field is optional except where noted.

{
  "project": { "name": "...", "start_date": "YYYY-MM-DD", "target_date": "YYYY-MM-DD" },
  "phases": [ { "id": "P1", "title": "...", "start_week": 1, "end_week": 4, "color": "#585CF0" } ],
  "agents": [ { "id": "lowercase-id", "name": "...", "type": "orchestrator|sub-agent|external", "parent_id": null, "source_model": "..." } ],
  "milestones": [ {
    "id": "M1", "title": "...", "domain": "one swim-lane name", "week": 1, "phase": "P1",
    "planned_start": "YYYY-MM-DD", "planned_end": "YYYY-MM-DD",
    "is_key_milestone": false, "key_milestone_label": null, "dependencies": ["earlier milestone ids only"],
    "tasks": [ { "label": "deliverable", "priority": "P0|P1|P2|P3", "acceptance_criteria": ["..."] } ]
  } ]
}

Rules: domains become swim lanes; phases referenced by a milestone must be listed in "phases"; a
milestone may depend only on milestones listed before it; dates are real calendar dates.

=== MANIFESTO ===
${manifesto}

=== ROADMAP ===
${roadmap}
`;
}
