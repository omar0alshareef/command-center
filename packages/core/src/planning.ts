import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nowIso, write, type Db } from './db';
import { CoreError, InvalidInputError } from './errors';
import { registerAgent, RESERVED_AGENT_IDS } from './agents';
import { createMilestone, isoDate } from './milestones';
import { getAgent, getMilestone, getProject, getTask, logAction } from './queries';
import { createTask } from './tasks';
import { PRIORITIES, toJson } from './types';

// M13 Planning Workspace. Everything here lives in the planning tables; the board is only touched by
// `approvePlan`, in one transaction (D15).

export const PLANNING_STATUSES = [
  'interviewing',
  'drafting',
  'review',
  'approved',
  'abandoned',
] as const;
export type PlanningStatus = (typeof PLANNING_STATUSES)[number];

export const PLANNING_KINDS = ['manifesto', 'roadmap'] as const;
export type PlanningKind = (typeof PLANNING_KINDS)[number];

export const PLANNER_STAGES = [
  'interview',
  'draft_manifesto',
  'draft_roadmap',
  'plan_stages',
  'plan_tasks',
  'propose_team',
] as const;
export type PlannerStage = (typeof PLANNER_STAGES)[number];

/**
 * The production stages a milestone can need (D21, revised in M13.1). Internally still called
 * capabilities. Several stages may share one team role.
 */
export const CAPABILITIES = [
  'frontend',
  'backend',
  'database',
  'security',
  'design',
  'marketing',
  'devops',
  'qa',
  'data',
  'script',
  'edit',
  'voiceover',
  'thumbnail',
  'publish',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_ROLES: Record<Capability, { id: string; name: string }> = {
  frontend: { id: 'frontend-team', name: 'Frontend' },
  backend: { id: 'backend-team', name: 'Backend' },
  database: { id: 'backend-team', name: 'Backend' },
  security: { id: 'security-team', name: 'Security' },
  design: { id: 'design-team', name: 'Design' },
  marketing: { id: 'marketing-team', name: 'Marketing' },
  devops: { id: 'devops-team', name: 'DevOps' },
  qa: { id: 'qa-team', name: 'QA' },
  data: { id: 'data-team', name: 'Data' },
  script: { id: 'script-team', name: 'Script' },
  edit: { id: 'editing-team', name: 'Editing' },
  voiceover: { id: 'voiceover-team', name: 'Voice-over' },
  thumbnail: { id: 'thumbnail-team', name: 'Thumbnail' },
  publish: { id: 'publishing-team', name: 'Publishing' },
};

/**
 * Who does a stage's work (D17 revised): `agent` = a text runner, `external` = a named tool outside the
 * app (the planner writes a brief and checklist, the operator runs it), `human` = the operator in person.
 */
export const EXECUTORS = ['agent', 'external', 'human'] as const;
export type Executor = (typeof EXECUTORS)[number];

/** Default executor per stage. Text runners do not edit media (D41), so media stages are external. */
export const STAGE_EXECUTORS: Record<Capability, { executor: Executor; tool: string | null }> = {
  frontend: { executor: 'agent', tool: null },
  backend: { executor: 'agent', tool: null },
  database: { executor: 'agent', tool: null },
  security: { executor: 'agent', tool: null },
  design: { executor: 'agent', tool: null },
  marketing: { executor: 'agent', tool: null },
  devops: { executor: 'agent', tool: null },
  qa: { executor: 'agent', tool: null },
  data: { executor: 'agent', tool: null },
  script: { executor: 'agent', tool: null },
  edit: { executor: 'external', tool: 'Video editor' },
  voiceover: { executor: 'external', tool: 'Voice tool' },
  thumbnail: { executor: 'external', tool: 'Image tool' },
  publish: { executor: 'human', tool: null },
};

// ---------- schemas ----------

const keyId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/, 'use letters, digits, . _ - (max 32 chars)');
const agentId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,47}$/, 'use lowercase letters, digits, . _ - (max 48 chars)');
const strings = z.array(z.string().trim().min(1)).max(50);

export const RequirementSchema = z.object({
  question: z.string(),
  answer: z.string().nullable(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const PlanMilestoneSchema = z.strictObject({
  id: keyId,
  title: z.string().trim().min(1).max(200),
  domain: z.string().trim().min(1).max(60),
  planned_start: isoDate,
  planned_end: isoDate,
  capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length),
  dependencies: z.array(z.string()).max(50).default([]),
  is_key_milestone: z.boolean().default(false),
});
export type PlanMilestone = z.infer<typeof PlanMilestoneSchema>;

export const PlanTaskSchema = z.strictObject({
  key: keyId,
  milestone: z.string().min(1),
  label: z.string().trim().min(1).max(300),
  priority: z.enum(PRIORITIES).default('P2'),
  due_date: isoDate.nullable(),
  capability: z.enum(CAPABILITIES).nullable().default(null),
  depends_on: z.array(z.string()).max(50).default([]),
  assignee: z.string().nullable().default(null),
  acceptance_criteria: strings.default([]),
  /** For external and human stages: what to do, and how the operator checks it is done. */
  brief: z.string().trim().max(4000).nullable().default(null),
  checklist: strings.default([]),
});
export type PlanTask = z.infer<typeof PlanTaskSchema>;

export const TeamRoleSchema = z.strictObject({
  id: agentId,
  name: z.string().trim().min(1).max(80),
  capabilities: z.array(z.enum(CAPABILITIES)).default([]),
  milestones: z.array(z.string()).default([]),
  executor: z.enum(EXECUTORS).default('agent'),
  tool: z.string().trim().min(1).max(80).nullable().default(null),
});
export type TeamRole = z.infer<typeof TeamRoleSchema>;

export const ProposalSchema = z.strictObject({
  milestones: z.array(PlanMilestoneSchema).default([]),
  tasks: z.array(PlanTaskSchema).default([]),
  team: z.array(TeamRoleSchema).default([]),
  /** What the planner assumed, per draft tab, so the operator can correct it. */
  assumptions: z.record(z.string(), z.array(z.string())).default({}),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const PlanningSessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  idea: z.string(),
  status: z.enum(PLANNING_STATUSES),
  requirements: z
    .string()
    .transform((s) => JSON.parse(s) as unknown)
    .pipe(z.array(RequirementSchema)),
  last_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PlanningSession = z.infer<typeof PlanningSessionSchema>;

export const PlanningDocumentSchema = z.object({
  id: z.number(),
  session_id: z.string(),
  kind: z.enum(PLANNING_KINDS),
  version: z.number(),
  content: z.string(),
  status: z.enum(['draft', 'approved', 'superseded']),
  created_at: z.string(),
  approved_at: z.string().nullable(),
});
export type PlanningDocument = z.infer<typeof PlanningDocumentSchema>;

/** Planner stage outputs. Each LLM stage replies with one JSON object of this shape (D20). */
export const StageOutputSchemas = {
  interview: z.strictObject({
    ready: z.boolean(),
    questions: z.array(z.string().trim().min(1)).max(10).default([]),
  }),
  draft_manifesto: z.strictObject({
    content: z.string().trim().min(1),
    assumptions: z.array(z.string()).default([]),
  }),
  draft_roadmap: z.strictObject({
    content: z.string().trim().min(1),
    assumptions: z.array(z.string()).default([]),
  }),
  plan_stages: z.strictObject({
    milestones: z.array(PlanMilestoneSchema).min(1),
    assumptions: z.array(z.string()).default([]),
  }),
  plan_tasks: z.strictObject({
    tasks: z.array(PlanTaskSchema).min(1),
    assumptions: z.array(z.string()).default([]),
  }),
} as const;
export type LlmStage = keyof typeof StageOutputSchemas;
export type StageOutput<S extends LlmStage> = z.infer<(typeof StageOutputSchemas)[S]>;

export class PlanValidationError extends CoreError {
  constructor(readonly issues: string[]) {
    super('PLAN_INVALID', issues.join('\n'));
  }
}

const zodIssues = (e: z.ZodError): string[] =>
  e.issues.map((i) => `${i.path.join('.') || 'output'}: ${i.message}`);

/**
 * Parse a runner's reply for one stage: tolerate a code fence or prose around ONE JSON object, then
 * validate it. Throws PlanValidationError naming the failing field; never returns partial data.
 */
export function parseStageOutput<S extends LlmStage>(stage: S, text: string): StageOutput<S> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new PlanValidationError([`${stage}: the planner did not reply with a JSON object.`]);
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new PlanValidationError([
      `${stage}: reply is not valid JSON (${e instanceof Error ? e.message : String(e)}).`,
    ]);
  }
  const r = StageOutputSchemas[stage].safeParse(raw);
  if (!r.success) throw new PlanValidationError(zodIssues(r.error).map((m) => `${stage}: ${m}`));
  return r.data as StageOutput<S>;
}

// ---------- pure planning logic ----------

/** One cycle in a directed graph as `a → b → a`, or null. Edges to unknown nodes are ignored. */
export function findCycle(graph: Map<string, readonly string[]>): string[] | null {
  const state = new Map<string, 1 | 2>(); // 1 = on the stack, 2 = finished
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const next of graph.get(n) ?? []) {
      if (!graph.has(next)) continue;
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const c = visit(next);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of graph.keys()) {
    if (state.has(n)) continue;
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

/**
 * Map milestone (and task) stages to team roles (D21): one role per distinct role id, listing only the
 * milestones that need it. Tasks with no assignee get the role of their stage. A role's executor is the
 * most hands-on of its stages: any human stage makes it human, else any external stage makes it external
 * (with that stage's tool), else agent.
 */
export function proposeTeam(
  milestones: readonly PlanMilestone[],
  tasks: readonly PlanTask[],
): { team: TeamRole[]; tasks: PlanTask[] } {
  const roles = new Map<string, TeamRole>();
  const add = (cap: Capability, milestoneId: string) => {
    const def = CAPABILITY_ROLES[cap];
    const role: TeamRole = roles.get(def.id) ?? {
      ...def,
      capabilities: [],
      milestones: [],
      executor: 'agent',
      tool: null,
    };
    if (!role.capabilities.includes(cap)) role.capabilities.push(cap);
    if (!role.milestones.includes(milestoneId)) role.milestones.push(milestoneId);
    roles.set(def.id, role);
  };
  for (const m of milestones) for (const c of m.capabilities) add(c, m.id);
  for (const t of tasks) if (t.capability) add(t.capability, t.milestone);
  for (const role of roles.values()) {
    const defs = role.capabilities.map((c) => STAGE_EXECUTORS[c]);
    const pick =
      defs.find((d) => d.executor === 'human') ?? defs.find((d) => d.executor === 'external');
    role.executor = pick?.executor ?? 'agent';
    role.tool = pick?.tool ?? null;
  }
  return {
    team: [...roles.values()],
    tasks: tasks.map((t) => ({
      ...t,
      assignee: t.assignee ?? (t.capability ? CAPABILITY_ROLES[t.capability].id : null),
    })),
  };
}

/**
 * Everything that would make approval fail, as messages naming the item. Empty = approvable.
 * References may point into the proposal or at rows already on the board.
 */
export function validatePlan(db: Db, raw: unknown): string[] {
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) return zodIssues(parsed.error);
  const p = parsed.data;
  const issues: string[] = [];

  const milestoneIds = new Set<string>();
  for (const m of p.milestones) {
    if (milestoneIds.has(m.id)) issues.push(`Milestone ${m.id}: duplicate id.`);
    milestoneIds.add(m.id);
    if (m.planned_end < m.planned_start)
      issues.push(`Milestone ${m.id}: planned_end is before planned_start.`);
  }
  for (const m of p.milestones)
    for (const d of m.dependencies)
      if (!milestoneIds.has(d) && !getMilestone(db, d))
        issues.push(`Milestone ${m.id}: depends on ${d}, which does not exist.`);
  const mCycle = findCycle(new Map(p.milestones.map((m) => [m.id, m.dependencies])));
  if (mCycle) issues.push(`Milestone dependency cycle: ${mCycle.join(' → ')}.`);

  const roleIds = new Set(p.team.map((r) => r.id));
  for (const r of p.team) {
    if (RESERVED_AGENT_IDS.includes(r.id)) issues.push(`Team role ${r.id}: reserved id.`);
    if (r.executor === 'external' && !r.tool)
      issues.push(`Team role ${r.id}: an external role needs the name of its tool.`);
  }

  const taskKeys = new Set<string>();
  for (const t of p.tasks) {
    if (taskKeys.has(t.key)) issues.push(`Task ${t.key}: duplicate key.`);
    taskKeys.add(t.key);
  }
  for (const t of p.tasks) {
    const name = `Task ${t.key} ("${t.label}")`;
    if (!milestoneIds.has(t.milestone) && !getMilestone(db, t.milestone))
      issues.push(`${name}: milestone ${t.milestone} does not exist.`);
    for (const d of t.depends_on) {
      if (d === t.key) issues.push(`${name}: depends on itself.`);
      else if (!taskKeys.has(d) && !getTask(db, d))
        issues.push(`${name}: depends on ${d}, which does not exist.`);
    }
    if (t.assignee && !roleIds.has(t.assignee) && !getAgent(db, t.assignee))
      issues.push(`${name}: assignee ${t.assignee} is not on the team.`);
    // An external or human task has no text runner to read the card: it must carry what to make and how it is checked.
    const executor = t.capability
      ? STAGE_EXECUTORS[t.capability].executor
      : ((t.assignee
          ? (p.team.find((r) => r.id === t.assignee)?.executor ??
            getAgent(db, t.assignee)?.executor)
          : null) ?? 'agent');
    if (executor !== 'agent') {
      if (!t.brief?.trim())
        issues.push(
          `${name}: ${executor === 'external' ? 'an' : 'a'} ${executor} task needs a brief (what to make, with every fact the person needs).`,
        );
      if (t.checklist.length === 0)
        issues.push(
          `${name}: ${executor === 'external' ? 'an' : 'a'} ${executor} task needs a checklist (how you check it is done).`,
        );
    }
  }
  const tCycle = findCycle(new Map(p.tasks.map((t) => [t.key, t.depends_on])));
  if (tCycle) issues.push(`Task dependency cycle: ${tCycle.join(' → ')}.`);
  return issues;
}

/** Milestones ordered so every dependency inside the plan comes first (input must be acyclic). */
function topoMilestones(ms: readonly PlanMilestone[]): PlanMilestone[] {
  const byId = new Map(ms.map((m) => [m.id, m]));
  const out: PlanMilestone[] = [];
  const seen = new Set<string>();
  const visit = (m: PlanMilestone) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    for (const d of m.dependencies) {
      const dep = byId.get(d);
      if (dep) visit(dep);
    }
    out.push(m);
  };
  ms.forEach(visit);
  return out;
}

// ---------- store ----------

const nextVersion = (db: Db, sessionId: string, kind: PlanningKind): number =>
  ((
    db
      .prepare('SELECT MAX(version) AS v FROM planning_documents WHERE session_id = ? AND kind = ?')
      .get(sessionId, kind) as { v: number | null }
  ).v ?? 0) + 1;

export function getPlanningSessionRow(db: Db, id: string): PlanningSession | null {
  const row = db.prepare('SELECT * FROM planning_sessions WHERE id = ?').get(id);
  return row ? PlanningSessionSchema.parse(row) : null;
}

function needSession(db: Db, id: string): PlanningSession {
  const s = getPlanningSessionRow(db, id);
  if (!s) throw new CoreError('SESSION_NOT_FOUND', `Planning session ${id} does not exist.`);
  return s;
}

function needOpen(db: Db, id: string): PlanningSession {
  const s = needSession(db, id);
  if (s.status === 'approved' || s.status === 'abandoned')
    throw new CoreError('SESSION_CLOSED', `Planning session ${id} is ${s.status}.`);
  return s;
}

export function listPlanningSessions(db: Db): PlanningSession[] {
  return PlanningSessionSchema.array().parse(
    db.prepare('SELECT * FROM planning_sessions ORDER BY created_at DESC, id').all(),
  );
}

export function createPlanningSession(db: Db, rawIdea: string, rawTitle?: string): PlanningSession {
  const idea = z.string().trim().min(1, 'describe the idea').max(20_000).parse(rawIdea);
  const title =
    z.string().trim().max(120).optional().parse(rawTitle) ||
    idea.split(/\s+/).slice(0, 8).join(' ').slice(0, 80);
  const id = `plan-${randomUUID().slice(0, 8)}`;
  const now = nowIso();
  db.prepare(
    'INSERT INTO planning_sessions (id, title, idea, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, title, idea, now, now);
  return needSession(db, id);
}

function updateSession(
  db: Db,
  id: string,
  sets: Partial<{ status: PlanningStatus; requirements: Requirement[]; last_error: string | null }>,
): PlanningSession {
  const params: Record<string, unknown> = { id, now: nowIso() };
  const cols = Object.keys(sets) as (keyof typeof sets)[];
  for (const c of cols) params[c] = c === 'requirements' ? toJson(sets[c] ?? []) : sets[c];
  db.prepare(
    `UPDATE planning_sessions SET ${[...cols.map((c) => `${c} = @${c}`), 'updated_at = @now'].join(', ')} WHERE id = @id`,
  ).run(params);
  return needSession(db, id);
}

export function setPlanningStatus(db: Db, id: string, status: PlanningStatus): PlanningSession {
  return write(db, () => {
    needOpen(db, id);
    return updateSession(db, id, { status, last_error: null });
  });
}

/** Record (or clear) the last planner error; shown in the panel instead of any draft change. */
export function setPlanningError(db: Db, id: string, error: string | null): PlanningSession {
  return write(db, () => updateSession(db, id, { last_error: error }));
}

export function addPlanningQuestions(db: Db, id: string, questions: string[]): PlanningSession {
  return write(db, () => {
    const s = needOpen(db, id);
    return updateSession(db, id, {
      requirements: [...s.requirements, ...questions.map((q) => ({ question: q, answer: null }))],
      last_error: null,
    });
  });
}

export function answerPlanningQuestion(
  db: Db,
  id: string,
  index: number,
  rawAnswer: string,
): PlanningSession {
  const answer = z.string().trim().max(10_000).parse(rawAnswer);
  return write(db, () => {
    const s = needOpen(db, id);
    const req = s.requirements[index];
    if (!req) throw new InvalidInputError(`Question ${index} does not exist.`);
    const requirements = s.requirements.slice();
    requirements[index] = { ...req, answer: answer || null };
    return updateSession(db, id, { requirements });
  });
}

/** The newest version of each document kind for a session. */
export function getSessionDocuments(db: Db, sessionId: string): PlanningDocument[] {
  return PlanningDocumentSchema.array().parse(
    db
      .prepare(
        `SELECT * FROM planning_documents d WHERE session_id = ? AND version =
           (SELECT MAX(version) FROM planning_documents WHERE session_id = d.session_id AND kind = d.kind)
         ORDER BY kind`,
      )
      .all(sessionId),
  );
}

/**
 * Save a draft document. `newVersion` (a planner run) adds a version; otherwise the operator's edit
 * replaces the newest draft in place.
 */
export function savePlanningDocument(
  db: Db,
  sessionId: string,
  kind: PlanningKind,
  rawContent: string,
  opts: { newVersion?: boolean } = {},
): PlanningDocument {
  const content = z.string().max(200_000).parse(rawContent);
  z.enum(PLANNING_KINDS).parse(kind);
  return write(db, () => {
    needOpen(db, sessionId);
    const latest = getSessionDocuments(db, sessionId).find((d) => d.kind === kind);
    if (latest && !opts.newVersion) {
      db.prepare('UPDATE planning_documents SET content = ? WHERE id = ?').run(content, latest.id);
    } else {
      db.prepare(
        'INSERT INTO planning_documents (session_id, kind, version, content, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(sessionId, kind, nextVersion(db, sessionId, kind), content, nowIso());
    }
    updateSession(db, sessionId, {});
    const doc = getSessionDocuments(db, sessionId).find((d) => d.kind === kind);
    if (!doc) throw new CoreError('DOCUMENT_NOT_FOUND', `No ${kind} for ${sessionId}.`);
    return doc;
  });
}

export function getPlanningProposal(db: Db, sessionId: string): Proposal | null {
  const row = db
    .prepare('SELECT proposal FROM planning_proposals WHERE session_id = ?')
    .get(sessionId) as { proposal: string } | undefined;
  return row ? ProposalSchema.parse(JSON.parse(row.proposal)) : null;
}

/** Replace the staged proposal (shape-validated only; references are checked at approval). */
export function savePlanningProposal(db: Db, sessionId: string, raw: unknown): Proposal {
  const proposal = ProposalSchema.parse(raw);
  return write(db, () => {
    needOpen(db, sessionId);
    db.prepare(
      `INSERT INTO planning_proposals (session_id, proposal, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET proposal = excluded.proposal, updated_at = excluded.updated_at`,
    ).run(sessionId, JSON.stringify(proposal), nowIso());
    updateSession(db, sessionId, {});
    return proposal;
  });
}

export function abandonPlanningSession(db: Db, id: string): PlanningSession {
  return write(db, () => {
    needOpen(db, id);
    db.prepare('DELETE FROM planning_proposals WHERE session_id = ?').run(id);
    return updateSession(db, id, { status: 'abandoned' });
  });
}

export interface PlanningSessionDetail {
  session: PlanningSession;
  documents: PlanningDocument[];
  proposal: Proposal | null;
}

export function getPlanningSession(db: Db, id: string): PlanningSessionDetail {
  return {
    session: needSession(db, id),
    documents: getSessionDocuments(db, id),
    proposal: getPlanningProposal(db, id),
  };
}

/** Planning documents across sessions, newest first; `status` defaults to approved (the live plan). */
export function getPlanningDocuments(
  db: Db,
  status: PlanningDocument['status'] | 'all' = 'approved',
): PlanningDocument[] {
  const where = status === 'all' ? '' : 'WHERE status = ?';
  return PlanningDocumentSchema.array().parse(
    db
      .prepare(`SELECT * FROM planning_documents ${where} ORDER BY created_at DESC, id DESC`)
      .all(...(status === 'all' ? [] : [status])),
  );
}

export interface PlanCounts {
  milestones: number;
  tasks: number;
  withDeadlines: number;
  dependencies: number;
  agents: number;
  /** Milestone stages by who does them: one per (role, milestone) pair, by the role's executor. */
  stages: Record<Executor, number>;
}

export function planCounts(p: Proposal): PlanCounts {
  const stages: Record<Executor, number> = { agent: 0, external: 0, human: 0 };
  for (const r of p.team) stages[r.executor] += r.milestones.length;
  return {
    milestones: p.milestones.length,
    tasks: p.tasks.length,
    withDeadlines: p.tasks.filter((t) => t.due_date).length,
    dependencies: p.tasks.reduce((n, t) => n + t.depends_on.length, 0),
    agents: p.team.length,
    stages,
  };
}

const DAY_MS = 86_400_000;

/**
 * Write the approved plan to the board in ONE transaction (D15): documents approved, team agents
 * registered, milestones created or updated, tasks created with due dates, assignees and mapped
 * dependencies. Any failure rolls everything back. `fault` is a test hook called after each batch.
 */
export function approvePlan(
  db: Db,
  sessionId: string,
  opts: { fault?: (step: string) => void } = {},
): PlanCounts & { taskIds: Record<string, string> } {
  return write(db, () => {
    const session = needOpen(db, sessionId);
    if (session.status !== 'review')
      throw new CoreError(
        'SESSION_NOT_READY',
        `Planning session ${sessionId} is ${session.status}; draft the plan first.`,
      );
    const proposal = getPlanningProposal(db, sessionId);
    if (!proposal || proposal.milestones.length === 0)
      throw new PlanValidationError(['The plan has no milestones.']);
    const issues = validatePlan(db, proposal);
    if (issues.length > 0) throw new PlanValidationError(issues);
    const at = nowIso();
    const log = (action: string, description: string) =>
      logAction(db, {
        agentId: 'operator',
        action,
        targetType: 'planning_session',
        targetId: sessionId,
        description,
        tags: ['planning', sessionId],
        at,
      });

    const docs = getSessionDocuments(db, sessionId);
    for (const d of docs) {
      db.prepare(
        "UPDATE planning_documents SET status = 'superseded' WHERE kind = ? AND status = 'approved'",
      ).run(d.kind);
      db.prepare(
        "UPDATE planning_documents SET status = 'approved', approved_at = ? WHERE id = ?",
      ).run(at, d.id);
    }
    log(
      'plan_documents_approved',
      `Approved ${docs.map((d) => `${d.kind} v${d.version}`).join(', ') || 'no documents'}`,
    );
    opts.fault?.('documents');

    for (const r of proposal.team)
      registerAgent(db, {
        id: r.id,
        name: r.name,
        type: 'sub-agent',
        permissions: r.capabilities,
        executor: r.executor,
        tool: r.tool,
      });
    log('plan_team_registered', `Team: ${proposal.team.map((r) => r.name).join(', ') || 'none'}`);
    opts.fault?.('agents');

    const projectStart = Date.parse(getProject(db).start_date);
    for (const m of topoMilestones(proposal.milestones)) {
      const week = Math.max(
        1,
        Math.floor((Date.parse(m.planned_start) - projectStart) / DAY_MS / 7) + 1,
      );
      if (getMilestone(db, m.id)) {
        db.prepare(
          `UPDATE milestones SET title = ?, domain = ?, week = ?, planned_start = ?, planned_end = ?,
             dependencies = ?, is_key_milestone = ?, updated_at = ? WHERE id = ?`,
        ).run(
          m.title,
          m.domain,
          week,
          m.planned_start,
          m.planned_end,
          toJson(m.dependencies),
          m.is_key_milestone ? 1 : 0,
          at,
          m.id,
        );
      } else {
        createMilestone(
          db,
          {
            id: m.id,
            title: m.title,
            domain: m.domain,
            week,
            planned_start: m.planned_start,
            planned_end: m.planned_end,
            dependencies: m.dependencies,
            is_key_milestone: m.is_key_milestone,
          },
          'operator',
        );
      }
    }
    log('plan_milestones_written', `${proposal.milestones.length} milestones`);
    opts.fault?.('milestones');

    const taskIds: Record<string, string> = {};
    for (const t of proposal.tasks) {
      const created = createTask(
        db,
        {
          milestoneId: t.milestone,
          label: t.label,
          priority: t.priority,
          assignee: t.assignee,
          // An external or human stage carries the planner's brief as the task prompt, and its
          // checklist joins the acceptance criteria (no new table).
          fields: {
            due_date: t.due_date,
            ...(t.brief ? { prompt: t.brief } : {}),
            acceptance_criteria: [...new Set([...t.acceptance_criteria, ...t.checklist])].map(
              (text) => ({ text, done: false }),
            ),
          },
        },
        'operator',
      );
      taskIds[t.key] = created.id;
    }
    for (const t of proposal.tasks) {
      if (t.depends_on.length === 0) continue;
      db.prepare('UPDATE subtasks SET depends_on = ? WHERE id = ?').run(
        toJson(t.depends_on.map((d) => taskIds[d] ?? d)),
        taskIds[t.key],
      );
    }
    const counts = planCounts(proposal);
    log(
      'plan_tasks_written',
      `${counts.tasks} tasks, ${counts.withDeadlines} with deadlines, ${counts.dependencies} dependencies`,
    );
    opts.fault?.('tasks');

    db.prepare('DELETE FROM planning_proposals WHERE session_id = ?').run(sessionId);
    updateSession(db, sessionId, { status: 'approved', last_error: null });
    log('plan_approved', `Plan "${session.title}" approved`);
    return { ...counts, taskIds };
  });
}

// ---------- prompts ----------

export interface PlannerContext {
  idea: string;
  requirements: Requirement[];
  today: string;
  manifesto?: string;
  roadmap?: string;
  milestones?: PlanMilestone[];
  /** M15: the project's AGENTS.md and the lessons that apply, read before anything is proposed. Absent when there are none. */
  projectRules?: string;
  lessons?: string;
}

const qa = (reqs: Requirement[]) =>
  reqs.length === 0
    ? '(none yet)'
    : reqs
        .map((r, i) => `Q${i + 1}: ${r.question}\nA${i + 1}: ${r.answer ?? '(not answered)'}`)
        .join('\n\n');

/** The stages a person or an outside tool does, for the plan_tasks prompt. */
const handsOn = () =>
  CAPABILITIES.filter((c) => STAGE_EXECUTORS[c].executor !== 'agent')
    .map((c) => {
      const d = STAGE_EXECUTORS[c];
      return `${c} (${d.executor === 'human' ? 'the operator in person' : (d.tool ?? 'outside tool')})`;
    })
    .join(', ');

const JSON_ONLY =
  'Reply with ONE JSON object and nothing else (no prose, no code fence). Strings may contain markdown.';

/** The prompt for one LLM stage. Each stage sees the operator's answers and the earlier stages' drafts. */
export function plannerPrompt(stage: LlmStage, c: PlannerContext): string {
  const base = `You are the planner in Command Center, helping an operator turn an idea into a project plan.
Today is ${c.today}.

=== IDEA ===
${c.idea}

=== OPERATOR ANSWERS ===
${qa(c.requirements)}
${
  c.projectRules
    ? `
=== PROJECT RULES (AGENTS.md) ===
The plan must respect these rules.
${c.projectRules}
`
    : ''
}${
    c.lessons
      ? `
${c.lessons}
`
      : ''
  }`;
  switch (stage) {
    case 'interview': {
      const first = c.requirements.length === 0;
      return `${base}
Decide whether you know enough to draft a manifesto, roadmap, milestones with dates and tasks with
deadlines. ${first ? 'This is the first round: ask at least 3 questions.' : 'Ask only what is still missing.'}
Ask only for decisions the operator must make: the goal and target audience, deadlines and fixed
dates, budget, whether anyone appears on camera or records in their own voice, and content limits
(what must not be shown or said). Do not ask who should do the work or which roles, people or
abilities are needed: the plan works that out from the stages.
${JSON_ONLY}
{ "ready": false, "questions": ["...", "..."] }
Set "ready": true with "questions": [] when you can draft.`;
    }
    case 'draft_manifesto':
      return `${base}
Write the project manifesto in markdown: goal, audience, scope, non-goals, principles, success measures.
List every assumption you made that the operator did not state.
${JSON_ONLY}
{ "content": "# Manifesto\\n...", "assumptions": ["..."] }`;
    case 'draft_roadmap':
      return `${base}
=== MANIFESTO ===
${c.manifesto ?? ''}

Write the roadmap in markdown. Give each milestone its own heading that starts with its id, e.g.
"## M1 — Accounts", followed by its goal, deliverables and dates. Respect every deadline the operator gave.
${JSON_ONLY}
{ "content": "# Roadmap\\n## M1 — ...", "assumptions": ["..."] }`;
    case 'plan_stages':
      return `${base}
=== ROADMAP ===
${c.roadmap ?? ''}

List the roadmap's milestones with real dates and the production stages each one needs, in the
"capabilities" field. Stages: ${CAPABILITIES.join(', ')}. Not every milestone needs every stage; use []
when none apply.
Dependencies name earlier milestone ids.
${JSON_ONLY}
{ "milestones": [ { "id": "M1", "title": "...", "domain": "one swim-lane name", "planned_start": "YYYY-MM-DD",
  "planned_end": "YYYY-MM-DD", "capabilities": ["backend"], "dependencies": [], "is_key_milestone": false } ],
  "assumptions": ["..."] }`;
    case 'plan_tasks':
      return `${base}
=== ROADMAP ===
${c.roadmap ?? ''}

=== MILESTONES ===
${JSON.stringify(c.milestones ?? [], null, 1)}

Break every milestone into concrete tasks. Give each task a short unique "key" (T1, T2, ...), its
milestone id, priority P0-P3, a "due_date" (YYYY-MM-DD, required when the requirements imply a deadline,
otherwise null), the one stage it belongs to in "capability" (or null), "depends_on" as other task keys,
and 1-5 verifiable acceptance criteria.
These stages are not done by a text runner: ${handsOn()}. For a task in one of them, also write a
"brief" (what to make, with every fact the person needs) and a "checklist" (how the operator checks it
is done). Leave "brief": null and "checklist": [] for every other task.
${JSON_ONLY}
{ "tasks": [ { "key": "T1", "milestone": "M1", "label": "...", "priority": "P1", "due_date": "YYYY-MM-DD",
  "capability": "backend", "depends_on": [], "acceptance_criteria": ["..."], "brief": null, "checklist": [] } ],
  "assumptions": ["..."] }`;
  }
}
