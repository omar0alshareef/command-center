// Dev-only fixture generator: 3 domains, 3 phases, 8 milestones, 60 tasks, 4 agents, 200 log rows,
// with drift, blocked and review tasks. Deterministic for a given (now, seed).
// Usage: npx tsx packages/core/src/seed.ts [projectRoot]   (default: $PROJECT_ROOT or cwd)
import { pathToFileURL } from 'node:url';
import { openDb, write, type Db } from './db';
import { logAction } from './queries';
import { toJson, type TaskStatus } from './types';

const DAY_MS = 86_400_000;
const CURRENT_WEEK = 7;

export interface SeedOptions {
  now?: Date;
  seed?: number;
}

export interface SeedSummary {
  milestones: number;
  tasks: number;
  agents: number;
  logRows: number;
}

function rng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const AGENTS = [
  {
    id: 'claude-code',
    name: 'claude-code',
    type: 'orchestrator',
    parent: null,
    color: '#8286FF',
    model: 'claude-sonnet-5-5',
  },
  {
    id: 'research-explorer',
    name: 'research_explorer',
    type: 'sub-agent',
    parent: 'claude-code',
    color: '#14B8A6',
    model: 'claude-haiku-5-5',
  },
  {
    id: 'code-quality',
    name: 'code_quality',
    type: 'sub-agent',
    parent: 'claude-code',
    color: '#EC4899',
    model: 'claude-haiku-5-5',
  },
  {
    id: 'deepseek-r1',
    name: 'deepseek-r1',
    type: 'external',
    parent: null,
    color: '#F97316',
    model: 'deepseek-r1',
  },
] as const;

const PHASES = [
  { id: 'phase-a', title: 'Foundation', start: 1, end: 4, color: '#585CF0' },
  { id: 'phase-b', title: 'Build', start: 5, end: 9, color: '#14B8A6' },
  { id: 'phase-c', title: 'Launch', start: 10, end: 13, color: '#F59E0B' },
];

// [id, title, noun, domain, week, phase, drift, key label, task count, depends on]
const MILESTONES = [
  ['M1', 'Core schema', 'schema', 'Platform', 1, 'phase-a', 0, null, 8, []],
  ['M2', 'API layer', 'API endpoint', 'Platform', 3, 'phase-a', 0, null, 8, ['M1']],
  ['M3', 'Auth & onboarding', 'login flow', 'Product', 3, 'phase-a', 3, null, 7, ['M1']],
  ['M4', 'Task workflows', 'workflow', 'Product', 6, 'phase-b', 5, 'Beta Release', 8, ['M2', 'M3']],
  ['M5', 'CI & releases', 'pipeline', 'Infra', 5, 'phase-b', -1, null, 7, []],
  ['M6', 'Reporting', 'report', 'Product', 8, 'phase-b', 0, null, 7, ['M4']],
  ['M7', 'Observability', 'dashboard', 'Infra', 9, 'phase-b', 0, null, 7, ['M5']],
  ['M8', 'V1.0 launch', 'release', 'Platform', 12, 'phase-c', 0, 'V1.0 Launch', 8, ['M6', 'M7']],
] as const;

const VERBS = [
  'Design',
  'Implement',
  'Test',
  'Document',
  'Review',
  'Wire up',
  'Refactor',
  'Harden',
];
const ASSIGNEES = [
  'claude-code',
  'research-explorer',
  'code-quality',
  'deepseek-r1',
  'operator',
  null,
];
const ACTIONS = [
  ['task_started', 'start'],
  ['task_completed', 'complete'],
  ['task_approved', 'approve'],
  ['exploration_complete', 'research'],
  ['file_edited', 'code'],
  ['lint_passed', 'quality'],
] as const;
// Status by task index for milestones around the current week; guarantees review + blocked exist.
const ACTIVE_CYCLE: TaskStatus[] = [
  'done',
  'done',
  'done',
  'in_progress',
  'review',
  'todo',
  'blocked',
  'todo',
];

export function seedDb(db: Db, opts: SeedOptions = {}): SeedSummary {
  const now = opts.now ?? new Date();
  const rand = rng(opts.seed ?? 42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY_MS;
  const start = monday - (CURRENT_WEEK - 1) * 7 * DAY_MS;

  let taskCount = 0;
  let logRows = 0;

  write(db, () => {
    db.prepare(
      `UPDATE project SET name = 'Demo Project', start_date = ?, target_date = ?, schedule_status = 'at_risk' WHERE id = 1`,
    ).run(day(start), day(start + 13 * 7 * DAY_MS - DAY_MS));

    const insAgent = db.prepare(
      `INSERT INTO agents (id, name, type, parent_id, color, status, permissions, source_model, created_at)
       VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?)`,
    );
    for (const a of AGENTS) {
      insAgent.run(
        a.id,
        a.name,
        a.type,
        a.parent,
        a.color,
        toJson(['read', 'write']),
        a.model,
        day(start),
      );
    }

    const insPhase = db.prepare(
      'INSERT INTO phases (id, title, start_week, end_week, color) VALUES (?, ?, ?, ?, ?)',
    );
    for (const p of PHASES) insPhase.run(p.id, p.title, p.start, p.end, p.color);

    const insMs = db.prepare(
      `INSERT INTO milestones (id, title, domain, week, phase, planned_start, planned_end, actual_start,
         drift_days, is_key_milestone, key_milestone_label, dependencies, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insTask = db.prepare(
      `INSERT INTO subtasks (id, milestone_id, label, status, done, assignee, blocked_by, blocked_reason,
         blocked_from, completed_at, completed_by, priority, notes, context_files, acceptance_criteria,
         constraints, depends_on, last_run_id, created_at, updated_at)
       VALUES (@id, @milestone_id, @label, @status, @done, @assignee, @blocked_by, @blocked_reason,
         @blocked_from, @completed_at, @completed_by, @priority, @notes, @context_files,
         @acceptance_criteria, @constraints, @depends_on, @last_run_id, @created_at, @updated_at)`,
    );

    for (const [id, title, noun, domain, week, phase, drift, keyLabel, count, deps] of MILESTONES) {
      const plannedStart = start + (week - 1) * 7 * DAY_MS;
      insMs.run(
        id,
        title,
        domain,
        week,
        phase,
        day(plannedStart),
        day(plannedStart + 6 * DAY_MS),
        week <= CURRENT_WEEK ? day(plannedStart + Math.max(drift, 0) * DAY_MS) : null,
        drift,
        keyLabel ? 1 : 0,
        keyLabel,
        toJson([...deps]),
        toJson(
          drift > 0
            ? [
                {
                  text: `Slipped ${drift} days: waiting on review.`,
                  author: 'operator',
                  at: new Date(now.getTime() - 2 * DAY_MS).toISOString(),
                },
              ]
            : [],
        ),
      );

      const past = week <= CURRENT_WEEK - 4;
      const active = week >= CURRENT_WEEK - 2 && week <= CURRENT_WEEK;
      for (let i = 0; i < count; i++) {
        taskCount++;
        const taskId = `TASK-${String(taskCount).padStart(3, '0')}`;
        const status: TaskStatus = past
          ? 'done'
          : active
            ? (ACTIVE_CYCLE[i % ACTIVE_CYCLE.length] as TaskStatus)
            : 'todo';
        const assignee = status === 'todo' && rand() < 0.5 ? null : pick(ASSIGNEES);
        const completedAt =
          status === 'done' ? new Date(now.getTime() - rand() * 13 * DAY_MS).toISOString() : null;
        const blocked = status === 'blocked';
        const created = new Date(plannedStart).toISOString();
        insTask.run({
          id: taskId,
          milestone_id: id,
          label: `${VERBS[i % VERBS.length]} ${noun}`,
          status,
          done: status === 'done' ? 1 : 0,
          assignee,
          blocked_by: blocked ? 'manual' : null,
          blocked_reason: blocked ? 'Waiting on API contract sign-off' : null,
          blocked_from: blocked ? 'in_progress' : null,
          completed_at: completedAt,
          completed_by: completedAt ? (assignee ?? 'operator') : null,
          priority: pick(['P0', 'P1', 'P1', 'P2', 'P2', 'P3']),
          notes: `Seeded task for ${title}.`,
          context_files: toJson([`src/${noun.replace(/\s+/g, '-')}.ts`]),
          acceptance_criteria: toJson([
            { text: 'Behaviour matches the spec', done: status === 'done' },
            { text: 'Typecheck and lint pass', done: status === 'done' || status === 'review' },
            { text: 'Covered by a test', done: status === 'done' },
          ]),
          constraints: toJson(['No new dependencies']),
          depends_on: toJson(
            i > 0 && rand() < 0.2 ? [`TASK-${String(taskCount - 1).padStart(3, '0')}`] : [],
          ),
          last_run_id: status === 'todo' ? null : `run-${taskId}`,
          created_at: created,
          updated_at: completedAt ?? created,
        });
      }
    }

    // 200 log rows over the last 10 days, oldest first so each agent's last_action_at ends up latest.
    const times = Array.from({ length: 200 }, () => now.getTime() - rand() * 10 * DAY_MS).sort(
      (a, b) => a - b,
    );
    for (const t of times) {
      const [action, tag] = pick(ACTIONS);
      const agent = pick(AGENTS);
      const target = `TASK-${String(1 + Math.floor(rand() * taskCount)).padStart(3, '0')}`;
      logAction(db, {
        agentId: agent.id,
        action,
        targetType: 'subtask',
        targetId: target,
        description: `${action.replace(/_/g, ' ')} on ${target}`,
        tags: [tag],
        at: new Date(t).toISOString(),
      });
      logRows++;
    }
  });

  return { milestones: MILESTONES.length, tasks: taskCount, agents: AGENTS.length, logRows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ?? process.env['PROJECT_ROOT'] ?? process.cwd();
  const db = openDb(root);
  const existing = (db.prepare('SELECT COUNT(*) AS n FROM subtasks').get() as { n: number }).n;
  if (existing > 0) {
    console.error(`Refusing to seed: ${root} already has ${existing} tasks.`);
    process.exit(1);
  }
  console.log(`Seeded ${root}:`, seedDb(db));
  db.close();
}
