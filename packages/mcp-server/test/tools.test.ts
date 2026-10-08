import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateTokens, getAgent, getMilestone, getTask, updateTask } from '@command-center/core';
import { connect, type Harness } from './harness';

const EXPECTED_TOOLS = [
  // read (9)
  'get_task_context',
  'get_task_summary',
  'get_project_status',
  'get_milestone_overview',
  'list_tasks',
  'get_task_history',
  'list_agents',
  'get_activity_feed',
  'get_lessons_learned',
  // task write (10)
  'start_task',
  'complete_task',
  'approve_task',
  'reject_task',
  'reset_task',
  'block_task',
  'unblock_task',
  'update_task',
  'log_action',
  'enrich_task',
  // milestone write (5)
  'add_milestone_note',
  'set_milestone_dates',
  'update_drift',
  'create_milestone',
  'add_milestone_task',
  // agent (1)
  'register_agent',
];

let h: Harness;
beforeEach(async () => {
  h = await connect();
});
afterEach(() => h.close());

const todoId = () =>
  (
    h.db
      .prepare(
        "SELECT id FROM subtasks WHERE status='todo' AND depends_on='[]' ORDER BY id LIMIT 1",
      )
      .get() as { id: string }
  ).id;

describe('tool surface', () => {
  it('exposes exactly the 25 tools, each described, each parameter described', async () => {
    const { tools } = await h.client.listTools();
    const undocumented: string[] = [];
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(tools).toHaveLength(25);
    for (const t of tools) {
      expect(t.description?.length ?? 0, `${t.name} description`).toBeGreaterThan(40);
      const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [k, v] of Object.entries(props))
        if (!v.description) undocumented.push(`${t.name}.${k}`);
      expect(t.inputSchema.additionalProperties, `${t.name} strict`).toBe(false);
    }
    expect(undocumented, 'parameters without a description').toEqual([]);
  });

  it('carries server instructions describing the loop', async () => {
    expect(h.client.getInstructions()).toMatch(/start_task[\s\S]*complete_task/);
  });
});

describe('read tools', () => {
  it('get_project_status', async () => {
    const r = await h.call('get_project_status');
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({
      name: 'Demo Project',
      week: 7,
      phase: 'Build',
      total_tasks: 60,
    });
  });

  it('list_tasks filters, counts and caps', async () => {
    const all = (await h.call('list_tasks', { limit: 5 })).json<{
      total: number;
      returned: number;
      tasks: unknown[];
    }>();
    expect(all).toMatchObject({ total: 60, returned: 5 });
    expect(all.tasks).toHaveLength(5);
    const blocked = (await h.call('list_tasks', { status: 'blocked' })).json<{
      tasks: { status: string; blocked_reason: string }[];
    }>();
    expect(blocked.tasks.length).toBeGreaterThan(0);
    expect(blocked.tasks.every((t) => t.status === 'blocked' && t.blocked_reason)).toBe(true);
    const m1 = (await h.call('list_tasks', { milestone_id: 'M1', priority: 'P0' })).json<{
      tasks: { milestone_id: string; priority: string }[];
    }>();
    expect(m1.tasks.every((t) => t.milestone_id === 'M1' && t.priority === 'P0')).toBe(true);
    expect(
      (await h.call('list_tasks', { limit: 100000 })).json<{ returned: number }>().returned,
    ).toBe(60); // clamped to 200
  });

  it('get_task_summary stays within ~500 tokens for every task', async () => {
    for (const { id } of h.db.prepare('SELECT id FROM subtasks').all() as { id: string }[]) {
      const r = await h.call('get_task_summary', { task_id: id });
      expect(r.isError).toBe(false);
      expect(estimateTokens(r.text), id).toBeLessThanOrEqual(500);
    }
  });

  it('get_task_summary shrinks a pathological task to fit its budget', async () => {
    updateTask(h.db, 'TASK-001', {
      acceptance_criteria: Array.from({ length: 40 }, (_, i) => ({
        text: `criterion ${i} ${'y'.repeat(100)}`,
        done: false,
      })),
      depends_on: Array.from({ length: 60 }, (_, i) => `TASK-${String(i + 1).padStart(3, '0')}`),
    });
    const r = await h.call('get_task_summary', { task_id: 'TASK-001' });
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(500);
    expect(() => r.json()).not.toThrow(); // still valid JSON, not a chopped string
  });

  it('get_task_context returns the six sections and enforces the ~8K cap with a notice', async () => {
    const small = await h.call('get_task_context', { task_id: 'TASK-001' });
    for (const s of [
      'Task description',
      'Acceptance criteria',
      'Context files',
      'Reference docs',
      'Constraints',
      'Relevant lessons',
    ]) {
      expect(small.text).toContain(`## ${s}`);
    }
    updateTask(h.db, 'TASK-001', { notes: 'long line of notes\n'.repeat(5000) });
    const big = await h.call('get_task_context', { task_id: 'TASK-001' });
    expect(big.isError).toBe(false);
    expect(estimateTokens(big.text)).toBeLessThanOrEqual(8000);
    expect(big.text).toMatch(
      /\[truncated: ~\d+ of ~\d+ tokens omitted to fit a 8000-token budget\. Call get_task_summary/,
    );
  });

  it('get_milestone_overview, get_task_history, list_agents, get_activity_feed (paged), get_lessons_learned', async () => {
    expect((await h.call('get_milestone_overview')).json<unknown[]>()).toHaveLength(8);
    expect(
      (await h.call('get_milestone_overview', { milestone_id: 'M4' })).json<{ id: string }[]>()[0]
        ?.id,
    ).toBe('M4');

    const id = todoId();
    await h.call('start_task', { task_id: id });
    const hist = (await h.call('get_task_history', { task_id: id })).json<{
      log: { action: string }[];
    }>();
    expect(hist.log[0]?.action).toBe('task_started');

    const agents = (await h.call('list_agents')).json<{ id: string; status: string }[]>();
    expect(agents.find((a) => a.id === 'test-client')?.status).toBe('active');

    const p1 = (await h.call('get_activity_feed', { limit: 10 })).json<{
      entries: { id: string; at: string }[];
      next_cursor: { before_timestamp: string; before_id: string } | null;
    }>();
    expect(p1.entries).toHaveLength(10);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = (await h.call('get_activity_feed', { limit: 10, ...p1.next_cursor })).json<{
      entries: { id: string }[];
    }>();
    expect(p2.entries.some((e) => p1.entries.some((x) => x.id === e.id))).toBe(false);
    expect(
      (await h.call('get_activity_feed', { target_id: id }))
        .json<{ entries: { target: string }[] }>()
        .entries.every((e) => e.target === id),
    ).toBe(true);

    expect((await h.call('get_lessons_learned')).json<unknown[]>()).toEqual([]);
  });
});

describe('task lifecycle through the tools', () => {
  it('start -> complete -> reject -> complete -> approve; the approval comes from an independent reviewer', async () => {
    const id = todoId();
    expect((await h.call('start_task', { task_id: id })).json()).toMatchObject({
      id,
      status: 'in_progress',
    });
    expect(
      (await h.call('complete_task', { task_id: id, summary: 'first pass' })).json(),
    ).toMatchObject({ status: 'review' });
    const reviewer = await h.another('reviewer-client');
    expect(
      (
        await reviewer.call('reject_task', {
          task_id: id,
          reason: 'Modal did not close on backdrop click',
        })
      ).json(),
    ).toMatchObject({ status: 'in_progress' });
    expect(
      (await h.call('complete_task', { task_id: id, summary: 'fixed backdrop' })).json(),
    ).toMatchObject({ status: 'review' });
    expect((await reviewer.call('approve_task', { task_id: id })).json()).toMatchObject({
      status: 'done',
    });

    expect(getTask(h.db, id)).toMatchObject({ status: 'done', done: true });
    const log = h.db
      .prepare(
        'SELECT agent_id, action FROM agent_log WHERE target_id = ? AND agent_id IN (?, ?) ORDER BY rowid',
      )
      .all(id, 'test-client', 'reviewer-client');
    expect(log).toEqual([
      { agent_id: 'test-client', action: 'task_started' },
      { agent_id: 'test-client', action: 'task_completed' },
      { agent_id: 'reviewer-client', action: 'task_rejected' },
      { agent_id: 'test-client', action: 'task_completed' },
      { agent_id: 'reviewer-client', action: 'task_approved' },
    ]);
    const lesson = (await h.call('get_lessons_learned', { task_id: id })).json<
      { rejection_reason: string }[]
    >();
    expect(lesson[0]?.rejection_reason).toContain('backdrop');
  });

  it('an agent cannot approve its own work, nor via a sub-agent it registered, nor via a puppet', async () => {
    const id = todoId();
    await h.call('start_task', { task_id: id });
    await h.call('complete_task', { task_id: id, summary: 'done' });

    const self = await h.call('approve_task', { task_id: id });
    expect(self.isError).toBe(true);
    expect(self.text).toMatch(
      /cannot approve .*submitted it for review.*operator or a different agent/,
    );

    await h.call('register_agent', { id: 'my-reviewer', name: 'My reviewer', type: 'sub-agent' });
    const viaChild = await h.call('approve_task', { task_id: id, agent_id: 'my-reviewer' });
    expect(viaChild.isError).toBe(true);
    expect(viaChild.text).toMatch(/same agent family/);

    await h.call('register_agent', { id: 'puppet', name: 'Puppet', type: 'orchestrator' });
    const viaPuppet = await h.call('approve_task', { task_id: id, agent_id: 'puppet' });
    expect(viaPuppet.isError).toBe(true);
    expect(viaPuppet.text).toMatch(/only as yourself .* or as agents registered under you/);

    expect(getTask(h.db, id)?.status).toBe('review'); // never moved
    const other = await h.another('someone-else');
    expect((await other.call('approve_task', { task_id: id })).json()).toMatchObject({
      status: 'done',
    });
  });

  it('a session may act only as itself or its own sub-agents, not as seeded unrelated agents', async () => {
    await h.call('register_agent', { id: 'kid', name: 'Kid', type: 'sub-agent' });
    expect((await h.call('log_action', { action: 'x', agent_id: 'kid' })).isError).toBe(false);
    expect((await h.call('log_action', { action: 'x', agent_id: 'deepseek-r1' })).isError).toBe(
      true,
    ); // top-level seed agent
    const mine = await h.another('claude-code'); // adopts the seeded orchestrator
    expect(
      (await mine.call('log_action', { action: 'x', agent_id: 'research-explorer' })).isError,
    ).toBe(false); // its seeded child
    expect((await mine.call('log_action', { action: 'x', agent_id: 'kid' })).isError).toBe(true); // someone else's child
  });

  it('block / unblock restores the previous status; reset clears', async () => {
    const id = todoId();
    await h.call('start_task', { task_id: id });
    expect(
      (
        await h.call('block_task', {
          task_id: id,
          reason: 'waiting on API',
          blocked_by: 'TASK-001',
        })
      ).json(),
    ).toMatchObject({ status: 'blocked', blocked_reason: 'waiting on API' });
    expect((await h.call('unblock_task', { task_id: id })).json()).toMatchObject({
      status: 'in_progress',
    });
    expect((await h.call('reset_task', { task_id: id })).json()).toMatchObject({ status: 'todo' });
  });

  it('log_action, enrich_task and update_task', async () => {
    const id = todoId();
    const logged = (
      await h.call('log_action', {
        action: 'exploration_complete',
        task_id: id,
        description: 'mapped files',
        tags: ['research'],
      })
    ).json<{ id: string }>();
    expect(
      h.db
        .prepare('SELECT agent_id, action, target_id, tags FROM agent_log WHERE id = ?')
        .get(logged.id),
    ).toEqual({
      agent_id: 'test-client',
      action: 'exploration_complete',
      target_id: id,
      tags: '["research"]',
    });

    const enriched = await h.call('enrich_task', {
      task_id: id,
      context_files: ['src/a.ts'],
      acceptance_criteria: ['extra criterion'],
      prompt: 'do it',
    });
    expect(enriched.isError).toBe(false);
    expect(getTask(h.db, id)).toMatchObject({
      prompt: 'do it',
      context_files: expect.arrayContaining(['src/a.ts']),
    });
    expect(getTask(h.db, id)?.acceptance_criteria.map((c) => c.text)).toContain('extra criterion');

    expect(
      (
        await h.call('update_task', { task_id: id, priority: 'P0', assignee: 'test-client' })
      ).json(),
    ).toMatchObject({ priority: 'P0', assignee: 'test-client' });
  });
});

describe('milestone and agent tools', () => {
  it('create_milestone, add_milestone_task, add_milestone_note, set_milestone_dates, update_drift', async () => {
    const m = (
      await h.call('create_milestone', {
        title: 'Reporting v2',
        domain: 'Product',
        week: 9,
        dependencies: ['M4'],
        is_key_milestone: true,
      })
    ).json<{ id: string }>();
    expect(m.id).toBe('M9');
    expect(getMilestone(h.db, 'M9')).toMatchObject({
      dependencies: ['M4'],
      is_key_milestone: true,
      key_milestone_label: 'Reporting v2',
    });

    const t = (
      await h.call('add_milestone_task', {
        milestone_id: 'M9',
        label: 'Draft report layout',
        priority: 'P1',
        acceptance_criteria: [{ text: 'matches spec', done: false }],
      })
    ).json<{ id: string }>();
    expect(t.id).toBe('TASK-061');
    expect(getTask(h.db, t.id)?.acceptance_criteria).toEqual([
      { text: 'matches spec', done: false },
    ]);

    expect(
      (await h.call('add_milestone_note', { milestone_id: 'M9', text: 'Scope agreed' })).json(),
    ).toMatchObject({ notes: 1 });
    expect(
      (
        await h.call('set_milestone_dates', { milestone_id: 'M9', actual_start: '2026-03-10' })
      ).json(),
    ).toMatchObject({ actual_start: '2026-03-10' });
    await h.call('update_drift', { milestone_id: 'M9', drift_days: 8, reason: 'design slipped' });
    expect((await h.call('get_project_status')).json()).toMatchObject({
      schedule_status: 'behind',
      max_drift_days: 8,
    });
  });

  it('register_agent: sub-agent defaults to a child of the session agent, then can act', async () => {
    await h.call('list_tasks'); // reads do not register
    expect(getAgent(h.db, 'test-client')).toBeNull();
    const a = (
      await h.call('register_agent', {
        id: 'research-explorer',
        name: 'Research Explorer',
        type: 'sub-agent',
        source_model: 'claude-haiku-5-5',
      })
    ).json<{ parent_id: string }>();
    expect(a.parent_id).toBe('test-client');
    expect(getAgent(h.db, 'test-client')?.type).toBe('orchestrator'); // auto-registered on the way

    const id = todoId();
    const logged = (
      await h.call('log_action', {
        action: 'exploration_complete',
        task_id: id,
        agent_id: 'research-explorer',
      })
    ).json<{ agent: string }>();
    expect(logged.agent).toBe('research-explorer');
    const tree = (await h.call('list_agents')).json<{ id: string; parent_id: string | null }[]>();
    expect(tree.find((x) => x.id === 'research-explorer')?.parent_id).toBe('test-client');
  });
});
