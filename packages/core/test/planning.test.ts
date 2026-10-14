import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  abandonPlanningSession,
  addPlanningQuestions,
  answerPlanningQuestion,
  approvePlan,
  createPlanningSession,
  findCycle,
  getPlanningDocuments,
  getPlanningSession,
  parseStageOutput,
  PlanValidationError,
  plannerPrompt,
  proposeTeam,
  savePlanningDocument,
  savePlanningProposal,
  setPlanningStatus,
  STAGE_EXECUTORS,
  validatePlan,
  type PlanMilestone,
  type PlanTask,
} from '../src/planning';
import {
  getAgent,
  getAllTrackerState,
  getTask,
  listAgents,
  listMilestones,
  listTasks,
} from '../src/queries';
import { registerAgent } from '../src/agents';
import { updateTask } from '../src/tasks';
import { openDb } from '../src/db';
import { tmpDb } from './helpers';

let t: ReturnType<typeof tmpDb>;
beforeEach(() => {
  t = tmpDb();
});
afterEach(() => t.cleanup());

const milestones: PlanMilestone[] = [
  {
    id: 'M1',
    title: 'Brand and landing page',
    domain: 'frontend',
    planned_start: '2026-01-05',
    planned_end: '2026-01-18',
    capabilities: ['design', 'frontend'],
    dependencies: [],
    is_key_milestone: false,
  },
  {
    id: 'M2',
    title: 'Accounts API',
    domain: 'backend',
    planned_start: '2026-01-19',
    planned_end: '2026-02-01',
    capabilities: ['backend', 'database'],
    dependencies: ['M1'],
    is_key_milestone: true,
  },
];
const task = (key: string, over: Partial<PlanTask> = {}): PlanTask => ({
  key,
  milestone: 'M1',
  label: `Task ${key}`,
  priority: 'P2',
  due_date: null,
  capability: null,
  depends_on: [],
  assignee: null,
  acceptance_criteria: [],
  brief: null,
  checklist: [],
  ...over,
});
const tasks: PlanTask[] = [
  task('T1', {
    capability: 'design',
    due_date: '2026-01-10',
    acceptance_criteria: ['logo exists'],
  }),
  task('T2', { capability: 'frontend', depends_on: ['T1'], due_date: '2026-01-16' }),
  task('T3', { milestone: 'M2', capability: 'backend', depends_on: ['T2'] }),
];

/** A session in review with manifesto, roadmap and a full proposal. */
function seeded() {
  const s = createPlanningSession(t.db, 'A small SaaS for booking yoga classes.');
  savePlanningDocument(t.db, s.id, 'manifesto', '# Manifesto\nBook classes.', { newVersion: true });
  savePlanningDocument(
    t.db,
    s.id,
    'roadmap',
    '# Roadmap\n## M1 — Brand\nLogo.\n## M2 — API\nAuth.',
    {
      newVersion: true,
    },
  );
  const team = proposeTeam(milestones, tasks);
  savePlanningProposal(t.db, s.id, { milestones, tasks: team.tasks, team: team.team });
  setPlanningStatus(t.db, s.id, 'review');
  return s;
}

describe('migration 005', () => {
  it('adds an optional due_date to tasks that edits and validates as a real date', () => {
    t.db.prepare("INSERT INTO milestones (id, title) VALUES ('M0', 'x')").run();
    t.db
      .prepare("INSERT INTO subtasks (id, milestone_id, label) VALUES ('TASK-001', 'M0', 'x')")
      .run();
    expect(getTask(t.db, 'TASK-001')?.due_date).toBeNull();
    expect(updateTask(t.db, 'TASK-001', { due_date: '2026-03-01' }).due_date).toBe('2026-03-01');
    expect(() => updateTask(t.db, 'TASK-001', { due_date: '2026-02-30' })).toThrow();
    expect(() => updateTask(t.db, 'TASK-001', { due_date: 5 })).toThrow();
  });

  it('upgrades an existing v4 database without touching its rows', () => {
    t.db.prepare("INSERT INTO milestones (id, title) VALUES ('M0', 'x')").run();
    t.db
      .prepare("INSERT INTO subtasks (id, milestone_id, label) VALUES ('TASK-001', 'M0', 'keep')")
      .run();
    t.db.exec(
      'DROP TABLE planning_proposals; DROP TABLE planning_documents; DROP TABLE planning_sessions; ALTER TABLE subtasks DROP COLUMN due_date; DELETE FROM schema_version WHERE version = 5;',
    );
    const again = openDb(t.root);
    try {
      expect(getTask(again, 'TASK-001')).toMatchObject({ label: 'keep', due_date: null });
      expect(again.prepare('SELECT COUNT(*) n FROM planning_sessions').get()).toEqual({ n: 0 });
    } finally {
      again.close();
    }
  });
});

describe('interview and drafts', () => {
  it('stores questions and answers on the session', () => {
    const s = createPlanningSession(t.db, 'An idea');
    addPlanningQuestions(t.db, s.id, ['Who is it for?', 'Deadline?', 'Stack?']);
    answerPlanningQuestion(t.db, s.id, 1, 'March 1');
    const d = getPlanningSession(t.db, s.id);
    expect(d.session.requirements).toEqual([
      { question: 'Who is it for?', answer: null },
      { question: 'Deadline?', answer: 'March 1' },
      { question: 'Stack?', answer: null },
    ]);
    expect(() => answerPlanningQuestion(t.db, s.id, 9, 'x')).toThrow(/does not exist/);
  });

  it('versions planner drafts and edits the newest draft in place', () => {
    const s = createPlanningSession(t.db, 'An idea');
    savePlanningDocument(t.db, s.id, 'manifesto', 'v1', { newVersion: true });
    savePlanningDocument(t.db, s.id, 'manifesto', 'v2', { newVersion: true });
    savePlanningDocument(t.db, s.id, 'manifesto', 'v2 edited');
    const docs = getPlanningSession(t.db, s.id).documents;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ version: 2, content: 'v2 edited', status: 'draft' });
  });

  it('abandoning clears the proposal and closes the session', () => {
    const s = seeded();
    abandonPlanningSession(t.db, s.id);
    expect(getPlanningSession(t.db, s.id)).toMatchObject({
      proposal: null,
      session: { status: 'abandoned' },
    });
    expect(() => savePlanningDocument(t.db, s.id, 'roadmap', 'x')).toThrow(/abandoned/);
  });
});

describe('stage output validation (D20)', () => {
  it('accepts a fenced JSON reply and rejects a wrong due_date type naming the field', () => {
    expect(
      parseStageOutput(
        'interview',
        'Sure:\n```json\n{"ready":false,"questions":["a","b","c"]}\n```',
      ),
    ).toEqual({ ready: false, questions: ['a', 'b', 'c'] });
    const bad = JSON.stringify({ tasks: [{ ...task('T1'), due_date: 20260101 }] });
    expect(() => parseStageOutput('plan_tasks', bad)).toThrow(/plan_tasks: tasks\.0\.due_date/);
    expect(() => parseStageOutput('draft_manifesto', 'no json here')).toThrow(PlanValidationError);
    expect(() => parseStageOutput('plan_stages', '{"milestones": [ }')).toThrow(/not valid JSON/);
  });

  it('builds a first-round interview prompt that asks for at least 3 questions', () => {
    const p = plannerPrompt('interview', {
      idea: 'Yoga app',
      requirements: [],
      today: '2026-01-01',
    });
    expect(p).toContain('at least 3 questions');
    expect(p).toContain('Yoga app');
  });
});

describe('capabilities to team (D21)', () => {
  it('lists the design role only on the milestone that needs design', () => {
    const { team, tasks: assigned } = proposeTeam(
      [
        milestones[0] as PlanMilestone,
        { ...(milestones[1] as PlanMilestone), capabilities: ['backend'] },
      ],
      [],
    );
    const design = team.find((r) => r.id === 'design-team');
    expect(design?.milestones).toEqual(['M1']);
    expect(team.find((r) => r.id === 'backend-team')?.milestones).toEqual(['M2']);
    expect(team.filter((r) => r.milestones.includes('M2')).map((r) => r.id)).toEqual([
      'backend-team',
    ]);
    expect(assigned).toEqual([]);
  });

  it('maps database to the backend role and assigns tasks by capability', () => {
    const { team, tasks: assigned } = proposeTeam(milestones, tasks);
    expect(team.find((r) => r.id === 'backend-team')?.capabilities).toEqual([
      'backend',
      'database',
    ]);
    expect(assigned.map((x) => x.assignee)).toEqual([
      'design-team',
      'frontend-team',
      'backend-team',
    ]);
    expect(
      proposeTeam(milestones, [task('T9', { assignee: 'me', capability: 'qa' })]).tasks[0]
        ?.assignee,
    ).toBe('me');
  });
});

describe('dependency validation', () => {
  it('finds cycles and returns null for a DAG', () => {
    expect(
      findCycle(
        new Map([
          ['a', ['b']],
          ['b', ['c']],
          ['c', []],
        ]),
      ),
    ).toBeNull();
    expect(
      findCycle(
        new Map([
          ['a', ['b']],
          ['b', ['c']],
          ['c', ['a']],
        ]),
      ),
    ).toEqual(['a', 'b', 'c', 'a']);
    expect(findCycle(new Map([['a', ['zzz']]]))).toBeNull();
  });

  it('names missing milestones, missing dependencies, cycles and unknown assignees', () => {
    const issues = validatePlan(t.db, {
      milestones,
      tasks: [
        task('A', { milestone: 'M9' }),
        task('B', { depends_on: ['NOPE'] }),
        task('C', { depends_on: ['D'] }),
        task('D', { depends_on: ['C'] }),
        task('E', { assignee: 'ghost' }),
      ],
      team: [],
    });
    expect(issues).toEqual([
      'Task A ("Task A"): milestone M9 does not exist.',
      'Task B ("Task B"): depends on NOPE, which does not exist.',
      'Task E ("Task E"): assignee ghost is not on the team.',
      'Task dependency cycle: C → D → C.',
    ]);
    expect(validatePlan(t.db, { tasks: [{ ...task('X'), due_date: 'soon' }] })[0]).toMatch(
      /^tasks\.0\.due_date/,
    );
  });

  it('accepts references to milestones and tasks already on the board', () => {
    t.db.prepare("INSERT INTO milestones (id, title) VALUES ('OLD', 'x')").run();
    t.db
      .prepare("INSERT INTO subtasks (id, milestone_id, label) VALUES ('TASK-007', 'OLD', 'x')")
      .run();
    expect(
      validatePlan(t.db, { tasks: [task('A', { milestone: 'OLD', depends_on: ['TASK-007'] })] }),
    ).toEqual([]);
  });
});

describe('approvePlan (D15)', () => {
  it('writes milestones, tasks with due dates and mapped dependencies, and the team in one go', () => {
    const s = seeded();
    const r = approvePlan(t.db, s.id);
    expect(r).toMatchObject({
      milestones: 2,
      tasks: 3,
      withDeadlines: 2,
      dependencies: 2,
      agents: 3,
    });
    expect(listMilestones(t.db).map((m) => [m.id, m.planned_start, m.week])).toEqual([
      ['M1', '2026-01-05', 1],
      ['M2', '2026-01-19', 3],
    ]);
    const [t1, t2, t3] = ['T1', 'T2', 'T3'].map((k) => getTask(t.db, r.taskIds[k] ?? ''));
    expect(t1).toMatchObject({ status: 'todo', due_date: '2026-01-10', assignee: 'design-team' });
    expect(t1?.acceptance_criteria).toEqual([{ text: 'logo exists', done: false }]);
    expect(t2?.depends_on).toEqual([t1?.id]);
    expect(t3?.depends_on).toEqual([t2?.id]);
    expect(listAgents(t.db).map((a) => a.id)).toEqual(
      expect.arrayContaining(['design-team', 'frontend-team', 'backend-team']),
    );
    const d = getPlanningSession(t.db, s.id);
    expect(d.session.status).toBe('approved');
    expect(d.proposal).toBeNull();
    expect(
      getPlanningDocuments(t.db)
        .map((x) => x.kind)
        .sort(),
    ).toEqual(['manifesto', 'roadmap']);
    const logged = t.db
      .prepare('SELECT action FROM agent_log WHERE target_id = ? ORDER BY rowid')
      .all(s.id) as { action: string }[];
    expect(logged.map((l) => l.action)).toEqual([
      'plan_documents_approved',
      'plan_team_registered',
      'plan_milestones_written',
      'plan_tasks_written',
      'plan_approved',
    ]);
  });

  it('a second approved plan supersedes the earlier documents', () => {
    approvePlan(t.db, seeded().id);
    t.db.exec('DELETE FROM subtasks; DELETE FROM milestones;');
    approvePlan(t.db, seeded().id);
    expect(getPlanningDocuments(t.db)).toHaveLength(2);
    expect(getPlanningDocuments(t.db, 'superseded')).toHaveLength(2);
  });

  it.each(['documents', 'agents', 'milestones', 'tasks'])(
    'rolls back everything when a fault hits after %s',
    (step) => {
      const s = seeded();
      const before = getAllTrackerState(t.db);
      expect(() =>
        approvePlan(t.db, s.id, {
          fault: (at) => {
            if (at === step) throw new Error(`fault after ${at}`);
          },
        }),
      ).toThrow(`fault after ${step}`);
      expect(getAllTrackerState(t.db)).toEqual(before);
      const d = getPlanningSession(t.db, s.id);
      expect(d.session.status).toBe('review');
      expect(d.proposal?.tasks).toHaveLength(3);
      expect(getPlanningDocuments(t.db)).toEqual([]);
    },
  );

  it('refuses an invalid plan, naming the item, and writes nothing', () => {
    const s = seeded();
    const p = getPlanningSession(t.db, s.id).proposal;
    if (!p) throw new Error('no proposal');
    savePlanningProposal(t.db, s.id, {
      ...p,
      tasks: [...p.tasks, task('T4', { depends_on: ['T5'] }), task('T5', { depends_on: ['T4'] })],
    });
    expect(() => approvePlan(t.db, s.id)).toThrow(/Task dependency cycle: T4 → T5 → T4/);
    expect(listTasks(t.db)).toEqual([]);
    expect(listMilestones(t.db)).toEqual([]);
  });

  it('needs the session in review', () => {
    const s = createPlanningSession(t.db, 'Idea');
    expect(() => approvePlan(t.db, s.id)).toThrow(/interviewing/);
  });

  it('drafts never appear in the board state before approval', () => {
    const empty = getAllTrackerState(t.db);
    seeded();
    expect(getAllTrackerState(t.db)).toEqual(empty);
  });
});

describe('M13.1 stage-based roster', () => {
  const video: PlanMilestone[] = [
    {
      id: 'V1',
      title: 'Episode 1',
      domain: 'video',
      planned_start: '2026-02-02',
      planned_end: '2026-02-13',
      capabilities: ['script', 'voiceover', 'edit', 'publish'],
      dependencies: [],
      is_key_milestone: false,
    },
  ];
  const videoTasks: PlanTask[] = [
    task('S1', { milestone: 'V1', capability: 'script' }),
    task('S2', {
      milestone: 'V1',
      capability: 'voiceover',
      depends_on: ['S1'],
      brief: 'Record the script in a calm voice, 3-4 minutes.',
      checklist: ['WAV at 48 kHz', 'no clipping'],
    }),
    task('S3', {
      milestone: 'V1',
      capability: 'publish',
      depends_on: ['S2'],
      brief: 'Upload the video to the channel with the approved title and description.',
      checklist: ['Title matches the plan', 'Scheduled for Monday 09:00'],
    }),
  ];

  it('stage schema accepts media stages and rejects unknown stages and executors', () => {
    const out = parseStageOutput('plan_stages', JSON.stringify({ milestones: video }));
    expect(out.milestones[0]?.capabilities).toEqual(['script', 'voiceover', 'edit', 'publish']);
    expect(() =>
      parseStageOutput(
        'plan_stages',
        JSON.stringify({ milestones: [{ ...video[0], capabilities: ['juggling'] }] }),
      ),
    ).toThrow(/plan_stages: milestones\.0\.capabilities\.0/);
    expect(validatePlan(t.db, { team: [{ id: 'x', name: 'X', executor: 'robot' }] })[0]).toMatch(
      /^team\.0\.executor/,
    );
  });

  it('executor defaults live in one table', () => {
    expect(STAGE_EXECUTORS.edit).toEqual({ executor: 'external', tool: 'Video editor' });
    expect(STAGE_EXECUTORS.voiceover).toEqual({ executor: 'external', tool: 'Voice tool' });
    expect(STAGE_EXECUTORS.thumbnail).toEqual({ executor: 'external', tool: 'Image tool' });
    expect(STAGE_EXECUTORS.publish).toEqual({ executor: 'human', tool: null });
    expect(STAGE_EXECUTORS.script.executor).toBe('agent');
    expect(STAGE_EXECUTORS.design.executor).toBe('agent');
  });

  it('maps stages to roles with executor and tool; design only where the roadmap has it', () => {
    const { team } = proposeTeam(
      [milestones[0] as PlanMilestone, { ...(milestones[1] as PlanMilestone), capabilities: [] }],
      [],
    );
    expect(team.filter((r) => r.milestones.includes('M1')).map((r) => r.id)).toContain(
      'design-team',
    );
    expect(team.filter((r) => r.milestones.includes('M2'))).toEqual([]);

    const v = proposeTeam(video, videoTasks);
    const byId = Object.fromEntries(v.team.map((r) => [r.id, r]));
    expect(byId['voiceover-team']).toMatchObject({ executor: 'external', tool: 'Voice tool' });
    expect(byId['editing-team']).toMatchObject({ executor: 'external', tool: 'Video editor' });
    expect(byId['publishing-team']).toMatchObject({ executor: 'human', tool: null });
    expect(byId['script-team']).toMatchObject({ executor: 'agent', tool: null });
    expect(v.tasks.map((x) => x.assignee)).toEqual([
      'script-team',
      'voiceover-team',
      'publishing-team',
    ]);
  });

  it('requires a brief and a checklist for every external and human task (M13.1 carry-over)', () => {
    const { team, tasks: assigned } = proposeTeam(video, videoTasks);
    const stripped = assigned.map((x) =>
      x.key === 'S2' ? { ...x, brief: null } : x.key === 'S3' ? { ...x, checklist: [] } : x,
    );
    expect(validatePlan(t.db, { milestones: video, tasks: stripped, team })).toEqual([
      'Task S2 ("Task S2"): an external task needs a brief (what to make, with every fact the person needs).',
      'Task S3 ("Task S3"): a human task needs a checklist (how you check it is done).',
    ]);
    // Agent tasks need neither.
    expect(validatePlan(t.db, { milestones: video, tasks: assigned, team })).toEqual([]);
  });

  it('flags an external role without a tool', () => {
    const { team, tasks: assigned } = proposeTeam(video, videoTasks);
    const broken = team.map((r) => (r.id === 'voiceover-team' ? { ...r, tool: null } : r));
    expect(validatePlan(t.db, { milestones: video, tasks: assigned, team: broken })).toEqual([
      'Team role voiceover-team: an external role needs the name of its tool.',
    ]);
  });

  it('interview prompt asks for decisions only, never roles or skills', () => {
    for (const requirements of [[], [{ question: 'Deadline?', answer: 'March' }]]) {
      const p = plannerPrompt('interview', {
        idea: 'A YouTube channel',
        requirements,
        today: '2026-01-01',
      });
      expect(p).not.toMatch(/skill/i);
      expect(p).not.toMatch(/\bteam\b/i);
      for (const w of ['deadlines', 'budget', 'on camera', 'content limits', 'target audience'])
        expect(p).toContain(w);
    }
    const tasksPrompt = plannerPrompt('plan_tasks', {
      idea: 'x',
      requirements: [],
      today: '2026-01-01',
    });
    expect(tasksPrompt).toContain('voiceover (Voice tool)');
    expect(tasksPrompt).toContain('publish (the operator in person)');
  });

  it('migration 006 applies on a 005 database; agents read back as agent; CHECK rejects others', () => {
    registerAgent(t.db, { id: 'old-bot', name: 'Old', type: 'sub-agent' });
    t.db.exec(
      'ALTER TABLE agents DROP COLUMN executor; ALTER TABLE agents DROP COLUMN tool; DELETE FROM schema_version WHERE version = 6;',
    );
    const again = openDb(t.root);
    try {
      expect(getAgent(again, 'old-bot')).toMatchObject({ executor: 'agent', tool: null });
      expect(getAgent(again, 'operator')?.executor).toBe('human');
      expect(getAgent(again, 'system')?.executor).toBe('external');
      expect(() =>
        again.prepare("UPDATE agents SET executor = 'robot' WHERE id = 'old-bot'").run(),
      ).toThrow(/CHECK constraint/);
    } finally {
      again.close();
    }
  });

  it('approval with mixed executors writes executor, tool, brief and checklist in one transaction', () => {
    const s = createPlanningSession(t.db, 'A weekly explainer video');
    const { team, tasks: assigned } = proposeTeam(video, videoTasks);
    savePlanningProposal(t.db, s.id, { milestones: video, tasks: assigned, team });
    setPlanningStatus(t.db, s.id, 'review');
    expect(() =>
      approvePlan(t.db, s.id, {
        fault: (at) => {
          if (at === 'tasks') throw new Error('boom');
        },
      }),
    ).toThrow('boom');
    expect(getAgent(t.db, 'voiceover-team')).toBeNull();
    expect(listTasks(t.db)).toEqual([]);

    const r = approvePlan(t.db, s.id);
    expect(r.stages).toEqual({ agent: 1, external: 2, human: 1 });
    expect(getAgent(t.db, 'voiceover-team')).toMatchObject({
      executor: 'external',
      tool: 'Voice tool',
    });
    expect(getAgent(t.db, 'publishing-team')).toMatchObject({ executor: 'human', tool: null });
    expect(getAgent(t.db, 'script-team')).toMatchObject({ executor: 'agent', tool: null });
    const vo = getTask(t.db, r.taskIds['S2'] ?? '');
    expect(vo?.prompt).toBe('Record the script in a calm voice, 3-4 minutes.');
    expect(vo?.acceptance_criteria.map((c) => c.text)).toEqual(['WAV at 48 kHz', 'no clipping']);
  });
});
